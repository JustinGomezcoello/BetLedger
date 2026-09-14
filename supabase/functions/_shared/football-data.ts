import type { Actor } from './auth.ts';
import { HttpError } from './http.ts';
import { calculateObjectiveStates } from './objectives.ts';
import { sha256Hex } from './source-extraction.ts';

type JsonRecord = Record<string, unknown>;
type CompetitionRow = {
  id: string;
  code: string;
  country_code: string | null;
  provider_ids: JsonRecord;
};

const record = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const stringValue = (value: unknown): string => typeof value === 'string' ? value : '';
const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const cacheTtlMs = (parameters: Record<string, string>) => (
  parameters.dateFrom || parameters.dateTo ? 20 * 60_000 : 150 * 60_000
);

const reserveCall = async (actor: Actor, endpoint: string) => {
  const { data, error } = await actor.admin.rpc('reserve_api_calls', {
    p_owner_id: actor.userId,
    p_provider: 'football_data',
    p_endpoint: endpoint,
    p_requested: 1,
    p_daily_limit: Number(Deno.env.get('FOOTBALL_DATA_DAILY_CAP') ?? 100),
  });
  if (error) throw new HttpError(500, 'quota_reservation_failed', error.message);
  const reservation = Array.isArray(data) ? data[0] : data;
  return Boolean(reservation?.allowed);
};

const markEndpointStale = async (actor: Actor, endpoint: string) => {
  const stale = await actor.admin.from('provider_payloads').update({ is_stale: true, data_state: 'stale' })
    .eq('owner_id', actor.userId).eq('provider', 'football_data').eq('endpoint', endpoint);
  if (stale.error) throw new HttpError(500, 'stale_marker_failed', stale.error.message);
};

const storePayload = async (
  actor: Actor,
  endpoint: string,
  query: URLSearchParams,
  status: number,
  payload: unknown,
  fetchedAt: string,
) => {
  const serialized = JSON.stringify(payload);
  const fingerprint = `${endpoint}?${query.toString()}`;
  const { data, error } = await actor.admin.from('provider_payloads').upsert({
    owner_id: actor.userId,
    provider: 'football_data',
    endpoint,
    fixture_id: null,
    request_fingerprint: fingerprint,
    fetched_at: fetchedAt,
    http_status: status,
    is_stale: false,
    data_state: status === 200 ? 'complete' : 'error',
    payload,
    payload_hash: await sha256Hex(serialized),
  }, { onConflict: 'owner_id,provider,request_fingerprint,payload_hash' }).select('id').single();
  if (error) throw new HttpError(500, 'payload_write_failed', error.message);
  return data.id as string;
};

const apiRequest = async (
  actor: Actor,
  endpoint: string,
  parameters: Record<string, string> = {},
) => {
  const token = Deno.env.get('FOOTBALL_DATA_API_KEY');
  if (!token) throw new HttpError(503, 'football_data_not_configured', 'Falta FOOTBALL_DATA_API_KEY');
  const query = new URLSearchParams(parameters);
  const requestFingerprint = `${endpoint}?${query.toString()}`;
  const cached = await actor.admin.from('provider_payloads')
    .select('id, payload, fetched_at')
    .eq('owner_id', actor.userId)
    .eq('provider', 'football_data')
    .eq('request_fingerprint', requestFingerprint)
    .eq('http_status', 200)
    .eq('is_stale', false)
    .gte('fetched_at', new Date(Date.now() - cacheTtlMs(parameters)).toISOString())
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cached.error) throw new HttpError(500, 'payload_cache_read_failed', cached.error.message);
  if (cached.data) {
    return {
      status: 'cached' as const,
      payload: cached.data.payload,
      payloadId: cached.data.id as string,
      providerCalls: 0,
    };
  }
  let providerCalls = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await reserveCall(actor, endpoint)) {
      await markEndpointStale(actor, endpoint);
      return { status: 'quota_exhausted' as const, payload: null, payloadId: null, providerCalls };
    }
    providerCalls += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(
        `https://api.football-data.org/v4/${endpoint}${query.size ? `?${query}` : ''}`,
        { headers: { 'X-Auth-Token': token }, signal: controller.signal },
      );
      const payload = await response.json();
      const fetchedAt = new Date().toISOString();
      const payloadId = await storePayload(actor, endpoint, query, response.status, payload, fetchedAt);
      if (response.ok) return { status: 'ok' as const, payload, payloadId, providerCalls };
      if (response.status !== 429 && response.status < 500) {
        throw new HttpError(502, 'provider_error', `football-data.org respondió ${response.status}`);
      }
      if (attempt === 2) throw new HttpError(502, 'provider_error', `football-data.org respondió ${response.status}`);
    } catch (error) {
      if (error instanceof HttpError || attempt === 2) {
        if (error instanceof HttpError) throw error;
        await markEndpointStale(actor, endpoint);
        throw new HttpError(502, 'provider_network_error', 'No se pudo conectar con football-data.org');
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt)));
  }
  throw new HttpError(502, 'provider_error', 'football-data.org no respondió');
};

const seasonLabel = (season: JsonRecord): string => {
  const start = stringValue(season.startDate);
  const year = Number(start.slice(0, 4));
  if (Number.isInteger(year) && year > 1900) return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  return String(new Date().getUTCFullYear());
};

const ensureTeam = async (
  actor: Actor,
  external: JsonRecord,
  countryCode: string | null,
) => {
  const externalId = finiteNumber(external.id);
  const name = stringValue(external.name).trim();
  if (externalId === undefined || !name) throw new HttpError(502, 'invalid_team_payload', 'Equipo incompleto en football-data.org');
  const mappingQuery = await actor.admin.from('team_provider_mappings')
    .select('team_id')
    .eq('owner_id', actor.userId)
    .eq('provider', 'football_data')
    .eq('external_id', String(externalId))
    .maybeSingle();
  if (mappingQuery.error) throw new HttpError(500, 'team_mapping_read_failed', mappingQuery.error.message);
  if (mappingQuery.data?.team_id) return mappingQuery.data.team_id as string;

  let teamQuery = actor.admin.from('teams')
    .select('id')
    .eq('owner_id', actor.userId)
    .eq('name', name);
  teamQuery = countryCode === null ? teamQuery.is('country_code', null) : teamQuery.eq('country_code', countryCode);
  const existing = await teamQuery.maybeSingle();
  if (existing.error) throw new HttpError(500, 'team_read_failed', existing.error.message);
  let teamId = existing.data?.id as string | undefined;
  if (!teamId) {
    const inserted = await actor.admin.from('teams').insert({
      owner_id: actor.userId,
      name,
      short_name: stringValue(external.shortName) || null,
      country_code: countryCode,
    }).select('id').single();
    if (inserted.error) throw new HttpError(500, 'team_write_failed', inserted.error.message);
    teamId = inserted.data.id as string;
  }
  const mapping = await actor.admin.from('team_provider_mappings').insert({
    owner_id: actor.userId,
    team_id: teamId,
    provider: 'football_data',
    external_id: String(externalId),
    external_name: name,
    mapping_status: 'verified',
  });
  if (mapping.error && mapping.error.code !== '23505') {
    throw new HttpError(500, 'team_mapping_write_failed', mapping.error.message);
  }
  return teamId;
};

const matchStatus = (raw: unknown): string => {
  const value = stringValue(raw).toUpperCase();
  if (value === 'FINISHED') return 'finished';
  if (value === 'IN_PLAY' || value === 'PAUSED') return 'in_progress';
  if (value === 'POSTPONED' || value === 'SUSPENDED') return 'postponed';
  if (value === 'CANCELLED') return 'cancelled';
  return 'scheduled';
};

const persistMatch = async (actor: Actor, competition: CompetitionRow, raw: unknown) => {
  const match = record(raw);
  const externalId = finiteNumber(match.id);
  const kickoffAt = stringValue(match.utcDate);
  if (externalId === undefined || !kickoffAt || !Number.isFinite(Date.parse(kickoffAt))) return 0;
  const homeTeamId = await ensureTeam(actor, record(match.homeTeam), competition.country_code);
  const awayTeamId = await ensureTeam(actor, record(match.awayTeam), competition.country_code);
  const season = seasonLabel(record(match.season));
  const score = record(match.score);
  const fullTime = record(score.fullTime);
  const homeScore = finiteNumber(fullTime.home);
  const awayScore = finiteNumber(fullTime.away);
  const status = matchStatus(match.status);

  const existingMapping = await actor.admin.from('fixture_provider_mappings')
    .select('fixture_id')
    .eq('owner_id', actor.userId)
    .eq('provider', 'football_data')
    .eq('external_id', String(externalId))
    .maybeSingle();
  if (existingMapping.error) throw new HttpError(500, 'fixture_mapping_read_failed', existingMapping.error.message);
  let fixtureId = existingMapping.data?.fixture_id as string | undefined;
  const hadProviderMapping = Boolean(fixtureId);
  if (!fixtureId) {
    const crossProvider = await actor.admin.from('fixtures').select('id')
      .eq('owner_id', actor.userId).eq('competition_id', competition.id)
      .eq('home_team_id', homeTeamId).eq('away_team_id', awayTeamId)
      .eq('kickoff_at', kickoffAt).maybeSingle();
    if (crossProvider.error) throw new HttpError(500, 'fixture_read_failed', crossProvider.error.message);
    fixtureId = crossProvider.data?.id as string | undefined;
  }

  const rule = await actor.admin.from('competition_rule_versions')
    .select('id')
    .eq('owner_id', actor.userId)
    .eq('competition_id', competition.id)
    .eq('season', season)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rule.error) throw new HttpError(500, 'rules_read_failed', rule.error.message);

  const reportedUpdatedAt = stringValue(match.lastUpdated);
  const sourceUpdatedAt = reportedUpdatedAt && Number.isFinite(Date.parse(reportedUpdatedAt))
    ? reportedUpdatedAt
    : new Date().toISOString();
  const resultAvailableAt = Date.parse(sourceUpdatedAt) >= Date.parse(kickoffAt)
    ? sourceUpdatedAt
    : new Date().toISOString();
  const payload: JsonRecord = {
    owner_id: actor.userId,
    competition_id: competition.id,
    rule_version_id: rule.data?.id ?? null,
    season,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    status,
    stage: stringValue(match.stage) || null,
    matchday: match.matchday === null || match.matchday === undefined ? null : String(match.matchday),
    home_score: homeScore ?? null,
    away_score: awayScore ?? null,
    provider_ids: { football_data: externalId },
    aggregate_context: {
      group: match.group ?? null,
      duration: score.duration ?? null,
      winner: score.winner ?? null,
    },
    source_updated_at: sourceUpdatedAt,
  };
  if (status === 'finished') payload.result_available_at = resultAvailableAt;

  if (fixtureId) {
    const current = await actor.admin.from('fixtures').select('status, provider_ids, result_available_at')
      .eq('id', fixtureId).eq('owner_id', actor.userId).single();
    if (current.error) throw new HttpError(500, 'fixture_read_failed', current.error.message);
    if (['finished', 'cancelled', 'abandoned'].includes(current.data.status)
        && !['finished', 'cancelled', 'abandoned'].includes(status)) {
      delete payload.status;
      delete payload.home_score;
      delete payload.away_score;
      delete payload.result_available_at;
    }
    if (current.data.result_available_at) delete payload.result_available_at;
    payload.provider_ids = { ...record(current.data.provider_ids), football_data: externalId };
    const updated = await actor.admin.from('fixtures').update(payload)
      .eq('id', fixtureId).eq('owner_id', actor.userId);
    if (updated.error) throw new HttpError(500, 'fixture_write_failed', updated.error.message);
    if (!hadProviderMapping) {
      const mapping = await actor.admin.from('fixture_provider_mappings').insert({
        owner_id: actor.userId,
        fixture_id: fixtureId,
        provider: 'football_data',
        external_id: String(externalId),
        external_updated_at: stringValue(match.lastUpdated) || null,
      });
      if (mapping.error) throw new HttpError(500, 'fixture_mapping_write_failed', mapping.error.message);
    }
    return hadProviderMapping ? 1 : 2;
  }

  const inserted = await actor.admin.from('fixtures').insert(payload).select('id').single();
  if (inserted.error) throw new HttpError(500, 'fixture_write_failed', inserted.error.message);
  fixtureId = inserted.data.id as string;
  const mapping = await actor.admin.from('fixture_provider_mappings').insert({
    owner_id: actor.userId,
    fixture_id: fixtureId,
    provider: 'football_data',
    external_id: String(externalId),
    external_updated_at: stringValue(match.lastUpdated) || null,
  });
  if (mapping.error) throw new HttpError(500, 'fixture_mapping_write_failed', mapping.error.message);
  return 2;
};

type Standing = {
  team: JsonRecord;
  position: number;
  played: number;
  won: number;
  draw: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
};

const persistStandings = async (
  actor: Actor,
  competition: CompetitionRow,
  payload: unknown,
  payloadId: string,
) => {
  const body = record(payload);
  const total = array(body.standings)
    .map(record)
    .filter((standing) => stringValue(standing.type).toUpperCase() === 'TOTAL')
    .sort((left, right) => array(right.table).length - array(left.table).length)[0];
  if (!total) return 0;
  const rows: Standing[] = array(total.table).map((entry) => {
    const item = record(entry);
    return {
      team: record(item.team),
      position: finiteNumber(item.position) ?? 0,
      played: finiteNumber(item.playedGames) ?? 0,
      won: finiteNumber(item.won) ?? 0,
      draw: finiteNumber(item.draw) ?? 0,
      lost: finiteNumber(item.lost) ?? 0,
      goalsFor: finiteNumber(item.goalsFor) ?? 0,
      goalsAgainst: finiteNumber(item.goalsAgainst) ?? 0,
      points: finiteNumber(item.points) ?? 0,
    };
  }).filter((row) => row.position > 0 && row.team.id);
  if (!rows.length) return 0;
  const season = seasonLabel(record(body.season));
  const asOf = new Date().toISOString();
  const rule = await actor.admin.from('competition_rule_versions').select('id, rules, verification_status')
    .eq('owner_id', actor.userId).eq('competition_id', competition.id).eq('season', season)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (rule.error) throw new HttpError(500, 'rules_read_failed', rule.error.message);
  const inserts = [];
  for (const row of rows) {
    const teamId = await ensureTeam(actor, row.team, competition.country_code);
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
      drawn: row.draw,
      lost: row.lost,
      goals_for: row.goalsFor,
      goals_against: row.goalsAgainst,
      points: row.points,
      objectives: calculateObjectiveStates(
        rows.map((candidate) => ({
          teamId: String(candidate.team.id),
          position: candidate.position,
          played: candidate.played,
          points: candidate.points,
        })),
        {
          teamId: String(row.team.id),
          position: row.position,
          played: row.played,
          points: row.points,
        },
        rule.data,
      ),
      source_provider: 'football_data',
      source_payload_id: payloadId,
    });
  }
  const write = await actor.admin.from('standings_snapshots').insert(inserts);
  if (write.error) throw new HttpError(500, 'standings_write_failed', write.error.message);
  return inserts.length;
};

export type FootballDataSyncOptions = {
  competitionCodes?: string[];
  date?: string;
  from?: string;
  to?: string;
};

export const syncFootballData = async (actor: Actor, options: FootballDataSyncOptions = {}) => {
  const query = actor.admin.from('competitions')
    .select('id, code, country_code, provider_ids')
    .eq('owner_id', actor.userId)
    .eq('enabled', true)
    .in('code', options.competitionCodes?.length ? options.competitionCodes : ['PL', 'PD', 'BL1', 'UCL']);
  const competitions = await query;
  if (competitions.error) throw new HttpError(500, 'competitions_read_failed', competitions.error.message);
  let callsUsed = 0;
  let recordsWritten = 0;
  let quotaExhausted = false;
  const endpoints: Array<Record<string, unknown>> = [];

  for (const rawCompetition of competitions.data ?? []) {
    const competition = rawCompetition as CompetitionRow;
    const externalCode = stringValue(record(competition.provider_ids).football_data);
    if (!externalCode) continue;
    const filters: Record<string, string> = {};
    if (options.date) {
      filters.dateFrom = options.date;
      filters.dateTo = options.date;
    } else if (options.from && options.to) {
      filters.dateFrom = options.from;
      filters.dateTo = options.to;
    } else if (options.from || options.to) {
      throw new HttpError(500, 'invalid_sync_window', 'El rango de sincronización requiere from y to');
    }
    const matchesEndpoint = `competitions/${encodeURIComponent(externalCode)}/matches`;
    const matches = await apiRequest(actor, matchesEndpoint, filters);
    endpoints.push({ endpoint: matchesEndpoint, status: matches.status, provider_calls: matches.providerCalls });
    if (matches.status === 'quota_exhausted') {
      callsUsed += matches.providerCalls;
      quotaExhausted = true;
      continue;
    }
    callsUsed += matches.providerCalls;
    if (matches.status === 'ok' || matches.status === 'cached') {
      for (const match of array(record(matches.payload).matches)) {
        recordsWritten += await persistMatch(actor, competition, match);
      }
    }

    if (['PL', 'PD', 'BL1', 'UCL'].includes(competition.code) && !options.date) {
      const standingsEndpoint = `competitions/${encodeURIComponent(externalCode)}/standings`;
      const standings = await apiRequest(actor, standingsEndpoint);
      endpoints.push({ endpoint: standingsEndpoint, status: standings.status, provider_calls: standings.providerCalls });
      if (standings.status === 'quota_exhausted') {
        callsUsed += standings.providerCalls;
        quotaExhausted = true;
      } else {
        callsUsed += standings.providerCalls;
        if (standings.status === 'ok' || standings.status === 'cached') {
          recordsWritten += await persistStandings(
            actor,
            competition,
            standings.payload,
            standings.payloadId as string,
          );
        }
      }
    }
  }
  return { configured: true, callsUsed, recordsWritten, quotaExhausted, endpoints };
};
