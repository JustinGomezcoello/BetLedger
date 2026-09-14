import type { Actor } from './auth.ts';
import { HttpError } from './http.ts';
import { calculateObjectiveStates } from './objectives.ts';
import { sha256Hex } from './source-extraction.ts';

type JsonRecord = Record<string, unknown>;
type FixtureRow = {
  id: string;
  kickoff_at: string;
  provider_ids: JsonRecord;
  status?: string;
  result_available_at?: string | null;
};

const record = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';
const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const cacheTtlMs = (endpoint: string, parameters: Record<string, string>) => {
  if (endpoint === 'fixtures/lineups') return 0;
  if (endpoint === 'injuries') return 60 * 60_000;
  if (endpoint === 'odds') return 20 * 60_000;
  if (endpoint === 'standings') return 5 * 60 * 60_000;
  if (endpoint === 'fixtures' && parameters.league) return 5 * 60 * 60_000;
  if (endpoint === 'fixtures') return 20 * 60_000;
  return 15 * 60_000;
};

const apiFootballDailyCap = () => {
  const configured = Number(Deno.env.get('API_FOOTBALL_DAILY_CAP') ?? 70);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 70) : 70;
};

const hasProviderErrors = (payload: unknown) => {
  const errors = record(payload).errors;
  if (Array.isArray(errors)) return errors.length > 0;
  return errors !== null && typeof errors === 'object' && Object.keys(errors as JsonRecord).length > 0;
};

const reserveCall = async (actor: Actor, endpoint: string) => {
  const { data, error } = await actor.admin.rpc('reserve_api_calls', {
    p_owner_id: actor.userId,
    p_provider: 'api_football',
    p_endpoint: endpoint,
    p_requested: 1,
    p_daily_limit: apiFootballDailyCap(),
  });
  if (error) throw new HttpError(500, 'quota_reservation_failed', error.message);
  const reservation = Array.isArray(data) ? data[0] : data;
  return Boolean(reservation?.allowed);
};

const markEndpointStale = async (actor: Actor, endpoint: string, fixtureId: string | null) => {
  let query = actor.admin.from('provider_payloads').update({ is_stale: true, data_state: 'stale' })
    .eq('owner_id', actor.userId).eq('provider', 'api_football').eq('endpoint', endpoint);
  query = fixtureId === null ? query.is('fixture_id', null) : query.eq('fixture_id', fixtureId);
  const staleWrite = await query;
  if (staleWrite.error) throw new HttpError(500, 'stale_marker_failed', staleWrite.error.message);
};

const storePayload = async (
  actor: Actor,
  fixtureId: string | null,
  endpoint: string,
  query: URLSearchParams,
  status: number,
  payload: unknown,
  fetchedAt: string,
) => {
  const serialized = JSON.stringify(payload);
  const fingerprint = `${endpoint}?${query.toString()}`;
  const responseItems = array(record(payload).response);
  const dataState = status !== 200 || hasProviderErrors(payload)
    ? 'error'
    : responseItems.length === 0 ? 'empty_unverified' : 'complete';
  const { data, error } = await actor.admin.from('provider_payloads').upsert({
    owner_id: actor.userId,
    provider: 'api_football',
    endpoint,
    fixture_id: fixtureId,
    request_fingerprint: fingerprint,
    fetched_at: fetchedAt,
    http_status: status,
    is_stale: false,
    data_state: dataState,
    payload,
    payload_hash: await sha256Hex(serialized),
  }, { onConflict: 'owner_id,provider,request_fingerprint,payload_hash' }).select('id').single();
  if (error) throw new HttpError(500, 'payload_write_failed', error.message);
  return { payloadId: data.id as string, dataState };
};

const apiRequest = async (
  actor: Actor,
  fixtureId: string | null,
  endpoint: string,
  parameters: Record<string, string>,
) => {
  const apiKey = Deno.env.get('API_FOOTBALL_KEY');
  if (!apiKey) throw new HttpError(503, 'api_football_not_configured', 'Falta API_FOOTBALL_KEY');
  const query = new URLSearchParams(parameters);
  const requestFingerprint = `${endpoint}?${query.toString()}`;
  const cacheTtl = cacheTtlMs(endpoint, parameters);
  if (cacheTtl > 0) {
    const cached = await actor.admin.from('provider_payloads')
      .select('id, payload, fetched_at')
      .eq('owner_id', actor.userId)
      .eq('provider', 'api_football')
      .eq('request_fingerprint', requestFingerprint)
      .eq('http_status', 200)
      .eq('is_stale', false)
      .neq('data_state', 'error')
      .gte('fetched_at', new Date(Date.now() - cacheTtl).toISOString())
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached.error) throw new HttpError(500, 'payload_cache_read_failed', cached.error.message);
    if (cached.data) {
      return {
        endpoint,
        status: 'cached' as const,
        payload: cached.data.payload,
        payloadId: cached.data.id as string,
        fetchedAt: cached.data.fetched_at as string,
        providerCalls: 0,
      };
    }
  }
  let providerCalls = 0;
  // The per-fixture lineup counter represents actual provider requests, so a
  // lineup lookup is deliberately not retried behind that counter.
  const maxAttempts = endpoint === 'fixtures/lineups' ? 1 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!await reserveCall(actor, endpoint)) {
      await markEndpointStale(actor, endpoint, fixtureId);
      return { endpoint, status: 'quota_exhausted' as const, payload: null, payloadId: null, fetchedAt: null, providerCalls };
    }
    providerCalls += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`https://v3.football.api-sports.io/${endpoint}?${query}`, {
        headers: { 'x-apisports-key': apiKey },
        signal: controller.signal,
      });
      const payload = await response.json();
      const fetchedAt = new Date().toISOString();
      const stored = await storePayload(actor, fixtureId, endpoint, query, response.status, payload, fetchedAt);
      if (response.ok && stored.dataState !== 'error') {
        return { endpoint, status: 'ok' as const, payload, payloadId: stored.payloadId, fetchedAt, providerCalls };
      }
      if (response.ok) {
        throw new HttpError(502, 'provider_error', 'API-Football devolvio errores en el payload');
      }
      if (response.status !== 429 && response.status < 500) {
        throw new HttpError(502, 'provider_error', `API-Football respondió ${response.status}`);
      }
      if (attempt === maxAttempts - 1) throw new HttpError(502, 'provider_error', `API-Football respondió ${response.status}`);
    } catch (error) {
      if (error instanceof HttpError || attempt === maxAttempts - 1) {
        if (error instanceof HttpError) throw error;
        await markEndpointStale(actor, endpoint, fixtureId);
        throw new HttpError(502, 'provider_network_error', 'No se pudo conectar con API-Football');
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt)));
  }
  throw new HttpError(502, 'provider_error', 'API-Football no respondió');
};

const localTeamId = async (actor: Actor, externalId: unknown) => {
  const { data, error } = await actor.admin
    .from('team_provider_mappings')
    .select('team_id')
    .eq('owner_id', actor.userId)
    .eq('provider', 'api_football')
    .eq('external_id', String(externalId))
    .eq('mapping_status', 'verified')
    .maybeSingle();
  if (error) throw new HttpError(500, 'team_mapping_read_failed', error.message);
  return data?.team_id as string | undefined;
};

const persistFixture = async (actor: Actor, fixtureRow: FixtureRow, payload: unknown) => {
  const first = array(record(payload).response)[0];
  if (!first) return 0;
  const item = record(first);
  const fixture = record(item.fixture);
  const goals = record(item.goals);
  const providerStatus = text(record(fixture.status).short).toUpperCase();
  if (!providerStatus) return 0;
  const status = providerStatus === 'FT' || providerStatus === 'AET' || providerStatus === 'PEN'
    ? 'finished'
    : providerStatus === 'PST' ? 'postponed'
      : providerStatus === 'CANC' ? 'cancelled'
        : providerStatus === '1H' || providerStatus === '2H' || providerStatus === 'HT' ? 'in_progress'
          : 'scheduled';
  if (['finished', 'cancelled', 'abandoned'].includes(fixtureRow.status ?? '')
      && !['finished', 'cancelled', 'abandoned'].includes(status)) return 0;
  const update: JsonRecord = {
    status,
    source_updated_at: new Date().toISOString(),
  };
  if (status === 'finished' && !fixtureRow.result_available_at) {
    update.result_available_at = update.source_updated_at;
  }
  const homeScore = finiteNumber(goals.home);
  const awayScore = finiteNumber(goals.away);
  if (homeScore !== undefined) update.home_score = homeScore;
  if (awayScore !== undefined) update.away_score = awayScore;
  const date = text(fixture.date);
  if (date) update.kickoff_at = date;
  const { error } = await actor.admin.from('fixtures').update(update).eq('id', fixtureRow.id).eq('owner_id', actor.userId);
  if (error) throw new HttpError(500, 'fixture_write_failed', error.message);
  return 1;
};

const persistInjuries = async (actor: Actor, fixtureId: string, externalFixtureId: number, payload: unknown) => {
  const now = new Date().toISOString();
  let written = 0;
  for (const raw of array(record(payload).response)) {
    const injury = record(raw);
    const player = record(injury.player);
    const team = record(injury.team);
    const teamId = await localTeamId(actor, team.id);
    if (!teamId || !player.id || !player.name) continue;
    const reason = `${text(player.type)} ${text(player.reason)}`.trim();
    const suspended = /suspend|card|ban/i.test(reason);
    const sourceHash = await sha256Hex(`api-football:${fixtureId}:${player.id}:${reason}`);
    let { data: observation, error: observationError } = await actor.admin.from('context_observations').insert({
      owner_id: actor.userId,
      fixture_id: fixtureId,
      team_id: teamId,
      entity_type: 'player',
      entity_ref: String(player.id),
      observation_type: suspended ? 'suspension' : 'injury',
      evidence_summary: `${text(player.name)}: ${reason || 'disponibilidad reportada por el proveedor'}`.slice(0, 1000),
      source_tier: 'structured',
      confidence: 0.75,
      source_url: `https://v3.football.api-sports.io/injuries?fixture=${externalFixtureId}`,
      source_hash: sourceHash,
      observed_at: now,
      fetched_at: now,
      valid_from: now,
      review_status: 'approved',
      initial_review_status: 'approved',
      metadata: { provider: 'api_football' },
    }).select('id').single();
    if (observationError?.code === '23505') {
      const existing = await actor.admin.from('context_observations').select('id')
        .eq('owner_id', actor.userId)
        .eq('fixture_id', fixtureId)
        .eq('source_hash', sourceHash)
        .single();
      observation = existing.data;
      observationError = existing.error;
    }
    if (observationError) throw new HttpError(500, 'injury_observation_write_failed', observationError.message);

    const { error: availabilityError } = await actor.admin.from('player_availability_snapshots').upsert({
      owner_id: actor.userId,
      fixture_id: fixtureId,
      team_id: teamId,
      player_external_ref: String(player.id),
      player_name: text(player.name),
      status: suspended ? 'suspended' : 'injured',
      probability_available: 0,
      source_observation_id: observation?.id ?? null,
      as_of: now,
    }, { onConflict: 'owner_id,fixture_id,player_external_ref,as_of' });
    if (availabilityError) throw new HttpError(500, 'availability_write_failed', availabilityError.message);
    written += 2;
  }
  return written;
};

const persistLineups = async (actor: Actor, fixtureId: string, externalFixtureId: number, payload: unknown) => {
  const now = new Date().toISOString();
  let written = 0;
  for (const raw of array(record(payload).response)) {
    const lineup = record(raw);
    const team = record(lineup.team);
    const teamId = await localTeamId(actor, team.id);
    if (!teamId) continue;
    const players = array(lineup.startXI)
      .map((entry) => record(record(entry).player))
      .filter((player) => player.id && player.name);
    if (players.length !== 11) continue;
    const { data: lineupRow, error } = await actor.admin.from('lineups').insert({
      owner_id: actor.userId,
      fixture_id: fixtureId,
      team_id: teamId,
      lineup_type: 'confirmed',
      scenario_probability: 1,
      formation: text(lineup.formation) || null,
      source_tier: 'structured',
      observed_at: now,
      source_url: `https://v3.football.api-sports.io/fixtures/lineups?fixture=${externalFixtureId}`,
      metadata: { provider: 'api_football', coach: record(lineup.coach).name ?? null },
    }).select('id').single();
    if (error || !lineupRow) throw new HttpError(500, 'lineup_write_failed', error?.message ?? 'No se creó la alineación');
    const { error: playerError } = await actor.admin.from('lineup_players').insert(players.map((player) => ({
        owner_id: actor.userId,
        lineup_id: lineupRow.id,
        player_external_ref: String(player.id),
        player_name: text(player.name),
        position: text(player.pos) || null,
        is_starter: true,
        expected_minutes: 90,
      })));
    if (playerError) throw new HttpError(500, 'lineup_players_write_failed', playerError.message);
    written += 12;
  }
  return written;
};

const normalizeMarket = (name: string, value: string) => {
  const marketName = name.toLowerCase();
  const outcomeName = value.toLowerCase();
  if (marketName.includes('match winner')) {
    if (outcomeName === 'home') return ['1x2', 'home'];
    if (outcomeName === 'draw') return ['1x2', 'draw'];
    if (outcomeName === 'away') return ['1x2', 'away'];
  }
  if (marketName.includes('over/under') || marketName.includes('goals over')) {
    if (outcomeName === 'over 2.5') return ['over_under_2_5', 'over'];
    if (outcomeName === 'under 2.5') return ['over_under_2_5', 'under'];
  }
  if (marketName.includes('both teams')) {
    if (outcomeName === 'yes') return ['btts', 'yes'];
    if (outcomeName === 'no') return ['btts', 'no'];
  }
  return null;
};

const persistOdds = async (actor: Actor, fixtureId: string, payload: unknown) => {
  const items: JsonRecord[] = [];
  for (const responseItem of array(record(payload).response)) {
    const response = record(responseItem);
    const providerObservedAt = text(response.update);
    const observedAt = providerObservedAt && Number.isFinite(Date.parse(providerObservedAt))
      ? providerObservedAt
      : new Date().toISOString();
    for (const bookmakerItem of array(response.bookmakers)) {
      const bookmaker = record(bookmakerItem);
      for (const betItem of array(bookmaker.bets)) {
        const bet = record(betItem);
        for (const valueItem of array(bet.values)) {
          const value = record(valueItem);
          const normalized = normalizeMarket(text(bet.name), text(value.value));
          const decimalOdds = finiteNumber(value.odd);
          if (!normalized || decimalOdds === undefined || decimalOdds <= 1) continue;
          items.push({
            owner_id: actor.userId,
            fixture_id: fixtureId,
            provider: 'api_football',
            bookmaker: text(bookmaker.name) || String(bookmaker.id ?? 'unknown'),
            market: normalized[0],
            outcome: normalized[1],
            decimal_odds: decimalOdds,
            observed_at: observedAt,
          });
        }
      }
    }
  }
  if (items.length) {
    const { error } = await actor.admin.from('odds_snapshots').upsert(items, {
      onConflict: 'owner_id,fixture_id,provider,bookmaker,market,outcome,observed_at',
    });
    if (error) throw new HttpError(500, 'odds_write_failed', error.message);
  }
  return items.length;
};

export const refreshApiFootballFixture = async (actor: Actor, fixture: FixtureRow) => {
  const externalId = finiteNumber(record(fixture.provider_ids).api_football);
  if (externalId === undefined || externalId <= 0) {
    return { configured: false, calls: [], recordsWritten: 0, message: 'El fixture no tiene mapping de API-Football' };
  }

  const calls = [];
  calls.push(await apiRequest(actor, fixture.id, 'fixtures', { id: String(externalId) }));
  calls.push(await apiRequest(actor, fixture.id, 'injuries', { fixture: String(externalId) }));
  calls.push(await apiRequest(actor, fixture.id, 'odds', { fixture: String(externalId), page: '1' }));

  const minutesToKickoff = (new Date(fixture.kickoff_at).getTime() - Date.now()) / 60_000;
  if (minutesToKickoff > 0 && minutesToKickoff <= 100) {
    const { data: allowed } = await actor.admin.rpc('reserve_fixture_provider_call', {
      p_owner_id: actor.userId,
      p_fixture_id: fixture.id,
      p_provider: 'api_football',
      p_counter_name: 'lineup',
      p_limit: 2,
    });
    if (allowed) calls.push(await apiRequest(actor, fixture.id, 'fixtures/lineups', { fixture: String(externalId) }));
  }

  let recordsWritten = 0;
  for (const call of calls) {
    if (!['ok', 'cached'].includes(call.status) || !call.payload) continue;
    if (call.endpoint === 'fixtures') recordsWritten += await persistFixture(actor, fixture, call.payload);
    if (call.endpoint === 'injuries') recordsWritten += await persistInjuries(actor, fixture.id, externalId, call.payload);
    if (call.endpoint === 'fixtures/lineups') recordsWritten += await persistLineups(actor, fixture.id, externalId, call.payload);
    if (call.endpoint === 'odds') recordsWritten += await persistOdds(actor, fixture.id, call.payload);
  }
  return {
    configured: true,
    calls: calls.map(({ endpoint, status, providerCalls }) => ({ endpoint, status, providerCalls })),
    recordsWritten,
  };
};

type CompetitionRow = {
  id: string;
  code: string;
  provider_ids: JsonRecord;
};

const ensureApiFootballTeam = async (actor: Actor, external: JsonRecord) => {
  const externalId = finiteNumber(external.id);
  const name = text(external.name).trim();
  if (externalId === undefined || !name) throw new HttpError(502, 'invalid_team_payload', 'Equipo incompleto en API-Football');
  const mapped = await actor.admin.from('team_provider_mappings').select('team_id')
    .eq('owner_id', actor.userId).eq('provider', 'api_football')
    .eq('external_id', String(externalId)).eq('mapping_status', 'verified').maybeSingle();
  if (mapped.error) throw new HttpError(500, 'team_mapping_read_failed', mapped.error.message);
  if (mapped.data?.team_id) return mapped.data.team_id as string;

  const candidates = await actor.admin.from('teams').select('id')
    .eq('owner_id', actor.userId).ilike('name', name).limit(2);
  if (candidates.error) throw new HttpError(500, 'team_read_failed', candidates.error.message);
  let teamId = candidates.data?.length === 1 ? candidates.data[0].id as string : undefined;
  if (!teamId) {
    const inserted = await actor.admin.from('teams').insert({
      owner_id: actor.userId,
      name,
      short_name: name,
      country_code: null,
    }).select('id').single();
    if (inserted.error) throw new HttpError(500, 'team_write_failed', inserted.error.message);
    teamId = inserted.data.id as string;
  }
  const mapping = await actor.admin.from('team_provider_mappings').insert({
    owner_id: actor.userId,
    team_id: teamId,
    provider: 'api_football',
    external_id: String(externalId),
    external_name: name,
    mapping_status: 'verified',
  });
  if (mapping.error && mapping.error.code !== '23505') throw new HttpError(500, 'team_mapping_write_failed', mapping.error.message);
  return teamId;
};

const apiFootballStatus = (value: unknown) => {
  const status = text(value).toUpperCase();
  if (['FT', 'AET', 'PEN'].includes(status)) return 'finished';
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P'].includes(status)) return 'in_progress';
  if (['PST', 'SUSP'].includes(status)) return 'postponed';
  if (status === 'CANC') return 'cancelled';
  if (status === 'ABD') return 'abandoned';
  return 'scheduled';
};

const apiFootballSeasonLabel = (value: unknown) => {
  const year = finiteNumber(value);
  return year === undefined ? String(new Date().getUTCFullYear()) : `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
};

const persistCompetitionFixture = async (actor: Actor, competition: CompetitionRow, raw: unknown) => {
  const item = record(raw);
  const providerFixture = record(item.fixture);
  const externalId = finiteNumber(providerFixture.id);
  const kickoffAt = text(providerFixture.date);
  if (externalId === undefined || !kickoffAt || !Number.isFinite(Date.parse(kickoffAt))) return 0;
  const teams = record(item.teams);
  const homeTeamId = await ensureApiFootballTeam(actor, record(teams.home));
  const awayTeamId = await ensureApiFootballTeam(actor, record(teams.away));
  const league = record(item.league);
  const season = apiFootballSeasonLabel(league.season);
  const status = apiFootballStatus(record(providerFixture.status).short);
  const goals = record(item.goals);
  const homeScore = finiteNumber(goals.home);
  const awayScore = finiteNumber(goals.away);
  const mapped = await actor.admin.from('fixture_provider_mappings').select('fixture_id')
    .eq('owner_id', actor.userId).eq('provider', 'api_football')
    .eq('external_id', String(externalId)).maybeSingle();
  if (mapped.error) throw new HttpError(500, 'fixture_mapping_read_failed', mapped.error.message);
  let fixtureId = mapped.data?.fixture_id as string | undefined;
  const hadProviderMapping = Boolean(fixtureId);
  if (!fixtureId) {
    const crossProvider = await actor.admin.from('fixtures').select('id')
      .eq('owner_id', actor.userId).eq('competition_id', competition.id)
      .eq('home_team_id', homeTeamId).eq('away_team_id', awayTeamId)
      .eq('kickoff_at', kickoffAt).maybeSingle();
    if (crossProvider.error) throw new HttpError(500, 'fixture_read_failed', crossProvider.error.message);
    fixtureId = crossProvider.data?.id as string | undefined;
  }
  const rule = await actor.admin.from('competition_rule_versions').select('id')
    .eq('owner_id', actor.userId).eq('competition_id', competition.id).eq('season', season)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (rule.error) throw new HttpError(500, 'rules_read_failed', rule.error.message);
  const update: JsonRecord = {
    owner_id: actor.userId,
    competition_id: competition.id,
    rule_version_id: rule.data?.id ?? null,
    season,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    status,
    stage: text(league.round) || null,
    matchday: text(league.round) || null,
    home_score: homeScore ?? null,
    away_score: awayScore ?? null,
    provider_ids: { api_football: externalId },
    aggregate_context: {
      venue: record(providerFixture.venue).name ?? null,
      referee: providerFixture.referee ?? null,
      timezone: providerFixture.timezone ?? null,
    },
    source_updated_at: new Date().toISOString(),
  };
  if (status === 'finished') update.result_available_at = update.source_updated_at;
  if (fixtureId) {
    const current = await actor.admin.from('fixtures').select('status, provider_ids, result_available_at')
      .eq('id', fixtureId).eq('owner_id', actor.userId).single();
    if (current.error) throw new HttpError(500, 'fixture_read_failed', current.error.message);
    if (['finished', 'cancelled', 'abandoned'].includes(current.data.status)
        && !['finished', 'cancelled', 'abandoned'].includes(status)) {
      delete update.status;
      delete update.home_score;
      delete update.away_score;
      delete update.result_available_at;
    }
    if (current.data.result_available_at) delete update.result_available_at;
    update.provider_ids = { ...record(current.data.provider_ids), api_football: externalId };
    const written = await actor.admin.from('fixtures').update(update)
      .eq('id', fixtureId).eq('owner_id', actor.userId);
    if (written.error) throw new HttpError(500, 'fixture_write_failed', written.error.message);
    if (!hadProviderMapping) {
      const mapping = await actor.admin.from('fixture_provider_mappings').insert({
        owner_id: actor.userId,
        fixture_id: fixtureId,
        provider: 'api_football',
        external_id: String(externalId),
      });
      if (mapping.error) throw new HttpError(500, 'fixture_mapping_write_failed', mapping.error.message);
    }
    return hadProviderMapping ? 1 : 2;
  }
  const inserted = await actor.admin.from('fixtures').insert(update).select('id').single();
  if (inserted.error) throw new HttpError(500, 'fixture_write_failed', inserted.error.message);
  fixtureId = inserted.data.id as string;
  const mapping = await actor.admin.from('fixture_provider_mappings').insert({
    owner_id: actor.userId,
    fixture_id: fixtureId,
    provider: 'api_football',
    external_id: String(externalId),
  });
  if (mapping.error) throw new HttpError(500, 'fixture_mapping_write_failed', mapping.error.message);
  return 2;
};

const persistApiFootballStandings = async (
  actor: Actor,
  competition: CompetitionRow,
  payload: unknown,
  payloadId: string | null,
) => {
  const response = record(array(record(payload).response)[0]);
  const league = record(response.league);
  const groups = array(league.standings)
    .filter((item): item is unknown[] => Array.isArray(item))
    .sort((left, right) => right.length - left.length);
  const table = groups[0] ?? [];
  if (!table.length) return 0;
  const season = apiFootballSeasonLabel(league.season);
  const rule = await actor.admin.from('competition_rule_versions')
    .select('id, rules, verification_status')
    .eq('owner_id', actor.userId)
    .eq('competition_id', competition.id)
    .eq('season', season)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rule.error) throw new HttpError(500, 'rules_read_failed', rule.error.message);
  const rawRows = table.map((item) => {
    const standing = record(item);
    const team = record(standing.team);
    const all = record(standing.all);
    const goals = record(all.goals);
    return {
      team,
      externalTeamId: String(team.id ?? ''),
      position: Math.trunc(finiteNumber(standing.rank) ?? 0),
      played: Math.trunc(finiteNumber(all.played) ?? 0),
      won: Math.trunc(finiteNumber(all.win) ?? 0),
      drawn: Math.trunc(finiteNumber(all.draw) ?? 0),
      lost: Math.trunc(finiteNumber(all.lose) ?? 0),
      goalsFor: Math.trunc(finiteNumber(goals.for) ?? 0),
      goalsAgainst: Math.trunc(finiteNumber(goals.against) ?? 0),
      points: finiteNumber(standing.points) ?? 0,
    };
  }).filter((row) => row.externalTeamId && row.position > 0);
  if (!rawRows.length) return 0;
  const objectiveRows = rawRows.map((row) => ({
    teamId: row.externalTeamId,
    position: row.position,
    played: row.played,
    points: row.points,
  }));
  const asOf = new Date().toISOString();
  const inserts = [];
  for (const row of rawRows) {
    const teamId = await ensureApiFootballTeam(actor, row.team);
    inserts.push({
      owner_id: actor.userId,
      competition_id: competition.id,
      rule_version_id: rule.data?.id ?? null,
      season,
      team_id: teamId,
      as_of: asOf,
      position: row.position,
      played: row.played,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,
      goals_for: row.goalsFor,
      goals_against: row.goalsAgainst,
      points: row.points,
      objectives: calculateObjectiveStates(
        objectiveRows,
        objectiveRows.find((candidate) => candidate.teamId === row.externalTeamId)!,
        rule.data,
      ),
      source_provider: 'api_football',
      source_payload_id: payloadId,
    });
  }
  const write = await actor.admin.from('standings_snapshots').insert(inserts);
  if (write.error) throw new HttpError(500, 'standings_write_failed', write.error.message);
  return inserts.length;
};

export const syncApiFootballCompetitions = async (
  actor: Actor,
  options: { competitionCodes?: string[]; date?: string; from?: string; to?: string } = {},
) => {
  const codes = options.competitionCodes?.length ? options.competitionCodes : ['UEL', 'UECL'];
  const competitions = await actor.admin.from('competitions')
    .select('id, code, provider_ids').eq('owner_id', actor.userId).eq('enabled', true).in('code', codes);
  if (competitions.error) throw new HttpError(500, 'competitions_read_failed', competitions.error.message);
  let callsUsed = 0;
  let recordsWritten = 0;
  let quotaExhausted = false;
  const endpoints: Array<Record<string, unknown>> = [];
  const currentYear = new Date().getUTCMonth() >= 6
    ? new Date().getUTCFullYear()
    : new Date().getUTCFullYear() - 1;

  for (const rawCompetition of competitions.data ?? []) {
    const competition = rawCompetition as CompetitionRow;
    const leagueId = finiteNumber(record(competition.provider_ids).api_football);
    if (leagueId === undefined) continue;
    let page = 1;
    let totalPages = 1;
    do {
      const parameters: Record<string, string> = {
        league: String(leagueId),
        season: String(currentYear),
        page: String(page),
      };
      const from = options.date ?? options.from;
      const to = options.date ?? options.to;
      if (from) parameters.from = from;
      if (to) parameters.to = to;
      if ((from && !to) || (!from && to)) {
        throw new HttpError(500, 'invalid_sync_window', 'El rango de sincronización requiere from y to');
      }
      const response = await apiRequest(actor, null, 'fixtures', parameters);
      endpoints.push({
        endpoint: 'fixtures',
        competition: competition.code,
        page,
        status: response.status,
        provider_calls: response.providerCalls,
      });
      if (response.status === 'quota_exhausted') {
        callsUsed += response.providerCalls;
        quotaExhausted = true;
        break;
      }
      callsUsed += response.providerCalls;
      if (response.status === 'ok' || response.status === 'cached') {
        for (const fixture of array(record(response.payload).response)) {
          recordsWritten += await persistCompetitionFixture(actor, competition, fixture);
        }
      }
      const paging = record(record(response.payload).paging);
      totalPages = Math.max(1, Math.min(10, Math.trunc(finiteNumber(paging.total) ?? 1)));
      page += 1;
    } while (page <= totalPages);

    if (['UCL', 'UEL', 'UECL'].includes(competition.code) && !quotaExhausted) {
      const standings = await apiRequest(actor, null, 'standings', {
        league: String(leagueId),
        season: String(currentYear),
      });
      endpoints.push({
        endpoint: 'standings',
        competition: competition.code,
        status: standings.status,
        provider_calls: standings.providerCalls,
      });
      callsUsed += standings.providerCalls;
      if (standings.status === 'quota_exhausted') {
        quotaExhausted = true;
      } else if (standings.status === 'ok' || standings.status === 'cached') {
        recordsWritten += await persistApiFootballStandings(
          actor,
          competition,
          standings.payload,
          standings.payloadId,
        );
      }
    }
  }
  return { configured: true, callsUsed, recordsWritten, quotaExhausted, endpoints };
};
