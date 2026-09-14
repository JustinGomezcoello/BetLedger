import type { Actor } from './auth.ts';
import { HttpError } from './http.ts';
import { inferDixonColesEloRates } from './inference-contract.ts';
import { predictionGenerationHash, predictionInputHash } from './prediction-identity.ts';
import { calculateSecondLegQualification } from './qualification.ts';
import { deterministicRatePerturbations } from './uncertainty.ts';

type JsonRecord = Record<string, unknown>;
type Fixture = {
  id: string;
  owner_id: string;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
  status: string;
  season: string;
  stage?: string | null;
  rule_version_id?: string | null;
  aggregate_context: JsonRecord;
  provider_ids: JsonRecord;
};
type HistoricalFixture = {
  id: string;
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
  kickoff_at: string;
};
type Scenario = { id: string; weight: number; home: number; away: number };
type LineupRateScenario = {
  id: string;
  weight: number;
  homeLogRateDelta: number;
  awayLogRateDelta: number;
};
type PredictionSnapshotReference = {
  id: string;
  market: string;
  outcome: string;
  decision: string;
};
type MarketKey = '1x2:home' | '1x2:draw' | '1x2:away'
  | 'over_under_2_5:over' | 'over_under_2_5:under'
  | 'btts:yes' | 'btts:no';

const PREDICTION_ENGINE_VERSION = 'betledger-football-engine/v2';

const record = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);
const numeric = (value: unknown, fallback = 0) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

const poisson = (lambda: number, maxGoals: number) => {
  const probabilities = new Array<number>(maxGoals + 1).fill(0);
  probabilities[0] = Math.exp(-lambda);
  for (let goal = 1; goal <= maxGoals; goal += 1) probabilities[goal] = probabilities[goal - 1] * lambda / goal;
  return probabilities;
};

const scoreGrid = (lambdaHome: number, lambdaAway: number, rho: number, maxGoals = 10) => {
  const home = poisson(lambdaHome, maxGoals);
  const away = poisson(lambdaAway, maxGoals);
  const grid = Array.from({ length: maxGoals + 1 }, () => new Array<number>(maxGoals + 1).fill(0));
  let total = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    for (let a = 0; a <= maxGoals; a += 1) {
      let tau = 1;
      if (h === 0 && a === 0) tau = 1 - lambdaHome * lambdaAway * rho;
      if (h === 0 && a === 1) tau = 1 + lambdaHome * rho;
      if (h === 1 && a === 0) tau = 1 + lambdaAway * rho;
      if (h === 1 && a === 1) tau = 1 - rho;
      const probability = home[h] * away[a] * Math.max(0, tau);
      grid[h][a] = probability;
      total += probability;
    }
  }
  return grid.map((row) => row.map((probability) => probability / total));
};

const mixedScoreGrid = (scenarios: Scenario[], rho: number, maxGoals = 10) => {
  const totalWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  if (totalWeight <= 0) throw new HttpError(500, 'invalid_scenarios', 'Los escenarios no tienen peso');
  const mixed = Array.from({ length: maxGoals + 1 }, () => new Array<number>(maxGoals + 1).fill(0));
  for (const scenario of scenarios) {
    const grid = scoreGrid(scenario.home, scenario.away, rho, maxGoals);
    const weight = scenario.weight / totalWeight;
    for (let home = 0; home <= maxGoals; home += 1) {
      for (let away = 0; away <= maxGoals; away += 1) {
        mixed[home][away] += weight * grid[home][away];
      }
    }
  }
  return mixed;
};

const markets = (grid: number[][]): Record<MarketKey, number> => {
  let home = 0;
  let draw = 0;
  let away = 0;
  let under = 0;
  let btts = 0;
  for (let h = 0; h < grid.length; h += 1) {
    for (let a = 0; a < grid[h].length; a += 1) {
      const probability = grid[h][a];
      if (h > a) home += probability;
      else if (h === a) draw += probability;
      else away += probability;
      if (h + a <= 2) under += probability;
      if (h > 0 && a > 0) btts += probability;
    }
  }
  return {
    '1x2:home': home,
    '1x2:draw': draw,
    '1x2:away': away,
    'over_under_2_5:over': 1 - under,
    'over_under_2_5:under': under,
    'btts:yes': btts,
    'btts:no': 1 - btts,
  };
};

const topScores = (grid: number[][]) => {
  const scores: Array<{ home: number; away: number; probability: number }> = [];
  for (let h = 0; h < grid.length; h += 1) {
    for (let a = 0; a < grid[h].length; a += 1) scores.push({ home: h, away: a, probability: grid[h][a] });
  }
  return scores.sort((left, right) => right.probability - left.probability).slice(0, 5);
};

const weightedQuantile = (values: Array<{ value: number; weight: number }>, quantile: number) => {
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of [...values].sort((left, right) => left.value - right.value)) {
    cumulative += item.weight / total;
    if (cumulative + Number.EPSILON >= quantile) return item.value;
  }
  return values[values.length - 1].value;
};

const smoothedAverage = (sum: number, count: number, prior: number, strength: number) => (
  (sum + prior * strength) / (count + strength)
);

const estimateLambdas = (
  history: HistoricalFixture[],
  fixture: Fixture,
  parameters: JsonRecord,
  competitionCode: string,
) => {
  const leagueHome = smoothedAverage(
    history.reduce((sum, match) => sum + match.home_score, 0),
    history.length,
    numeric(parameters.home_lambda_prior, 1.55),
    20,
  );
  const leagueAway = smoothedAverage(
    history.reduce((sum, match) => sum + match.away_score, 0),
    history.length,
    numeric(parameters.away_lambda_prior, 1.25),
    20,
  );
  const homeMatches = history.filter((match) => match.home_team_id === fixture.home_team_id);
  const awayMatches = history.filter((match) => match.away_team_id === fixture.away_team_id);
  const smoothing = numeric(parameters.smoothing_matches, 5);
  const homeScored = smoothedAverage(homeMatches.reduce((sum, match) => sum + match.home_score, 0), homeMatches.length, leagueHome, smoothing);
  const homeConceded = smoothedAverage(homeMatches.reduce((sum, match) => sum + match.away_score, 0), homeMatches.length, leagueAway, smoothing);
  const awayScored = smoothedAverage(awayMatches.reduce((sum, match) => sum + match.away_score, 0), awayMatches.length, leagueAway, smoothing);
  const awayConceded = smoothedAverage(awayMatches.reduce((sum, match) => sum + match.home_score, 0), awayMatches.length, leagueHome, smoothing);
  let home = leagueHome * (homeScored / leagueHome) * (awayConceded / leagueHome);
  let away = leagueAway * (awayScored / leagueAway) * (homeConceded / leagueAway);
  let rho = clamp(numeric(parameters.rho, 0), -0.2, 0.2);
  const contracted = inferDixonColesEloRates(
    parameters,
    competitionCode,
    fixture.home_team_id,
    fixture.away_team_id,
  );
  if (contracted) {
    home = contracted.home;
    away = contracted.away;
    rho = contracted.rho;
  }
  return {
    home: clamp(home, 0.15, 5),
    away: clamp(away, 0.15, 5),
    leagueHome,
    leagueAway,
    homeMatches: homeMatches.length,
    awayMatches: awayMatches.length,
    rho,
    contractValid: contracted !== null,
  };
};

const factorForObservation = (type: string) => {
  if (['injury', 'suspension', 'return'].includes(type)) return 'availability';
  if (type === 'rotation') return 'lineup';
  if (['rest', 'schedule_congestion'].includes(type)) return 'rest';
  return 'objectives';
};

const loadContext = async (
  actor: Actor,
  fixture: Fixture,
  parameters: JsonRecord,
  dataCutoff: string,
) => {
  const cutoffMs = Date.parse(dataCutoff);
  const observations = await actor.admin.from('context_observations')
    .select('id, team_id, entity_type, entity_ref, observation_type, source_tier, confidence, is_conflicted, conflict_group, initial_review_status, valid_from, observed_at')
    .eq('owner_id', actor.userId).eq('fixture_id', fixture.id)
    .lte('observed_at', dataCutoff)
    .lte('fetched_at', dataCutoff)
    .or(`expires_at.is.null,expires_at.gte.${dataCutoff}`);
  if (observations.error) throw new HttpError(500, 'context_read_failed', observations.error.message);
  const validAtCutoff = (observations.data ?? []).filter((item) => (
    !item.valid_from || Date.parse(item.valid_from) <= cutoffMs
  ));
  const observationIds = validAtCutoff.map((item) => item.id as string);
  const reviews = observationIds.length
    ? await actor.admin.from('context_reviews').select('id, observation_id, decision, scenario_adjustment, reviewed_at')
      .eq('owner_id', actor.userId).in('observation_id', observationIds)
      .lte('reviewed_at', dataCutoff)
      .order('reviewed_at', { ascending: false })
      .order('id', { ascending: true })
    : { data: [], error: null };
  if (reviews.error) throw new HttpError(500, 'context_reviews_read_failed', reviews.error.message);
  const latestReview = new Map<string, { decision: string; adjustment: JsonRecord }>();
  for (const review of reviews.data ?? []) {
    if (!latestReview.has(review.observation_id)) {
      latestReview.set(review.observation_id, {
        decision: String(review.decision),
        adjustment: record(review.scenario_adjustment),
      });
    }
  }
  const validEvidence = validAtCutoff.filter((item) => {
    const effectiveStatus = latestReview.get(item.id)?.decision ?? item.initial_review_status;
    return effectiveStatus === 'approved' || effectiveStatus === 'corrected';
  });
  const pendingMaterial = validAtCutoff.some((item) => {
    const effectiveStatus = latestReview.get(item.id)?.decision ?? item.initial_review_status;
    return effectiveStatus === 'pending'
      && ['official', 'structured', 'press'].includes(String(item.source_tier))
      && item.observation_type !== 'other';
  });
  const tierPriority: Record<string, number> = { official: 5, structured: 4, press: 3, community: 2, rumor: 1 };
  const effectiveByFact = new Map<string, typeof validEvidence[number]>();
  for (const item of [...validEvidence].sort((left, right) => (
    (tierPriority[right.source_tier] ?? 0) - (tierPriority[left.source_tier] ?? 0)
      || Date.parse(right.observed_at) - Date.parse(left.observed_at)
      || String(left.id).localeCompare(String(right.id))
  ))) {
    const factKey = [item.team_id ?? '', item.entity_type, item.entity_ref ?? item.id, item.observation_type].join(':');
    if (!effectiveByFact.has(factKey)) effectiveByFact.set(factKey, item);
  }
  const evidence = [...effectiveByFact.values()];
  const evidenceIds = evidence.map((item) => item.id as string);
  const contextEnabled = parameters.context_enabled === true;
  const coefficients = record(parameters.context_coefficients);
  const grouped: Record<string, { home: number; away: number }> = {
    objectives: { home: 0, away: 0 },
    rest: { home: 0, away: 0 },
    availability: { home: 0, away: 0 },
    lineup: { home: 0, away: 0 },
  };
  if (contextEnabled) {
    for (const observation of evidence) {
      if (!['official', 'structured', 'press'].includes(observation.source_tier)) continue;
      const factor = factorForObservation(String(observation.observation_type));
      const explicit = latestReview.get(observation.id)?.adjustment ?? {};
      const defaultDelta = numeric(coefficients[String(observation.observation_type)], 0);
      let homeDelta = numeric(explicit.home_log_rate_delta, 0);
      let awayDelta = numeric(explicit.away_log_rate_delta, 0);
      if (homeDelta === 0 && awayDelta === 0 && defaultDelta !== 0) {
        const scaled = defaultDelta * clamp(numeric(observation.confidence, 0.5), 0, 1);
        if (observation.team_id === fixture.home_team_id) homeDelta = scaled;
        if (observation.team_id === fixture.away_team_id) awayDelta = scaled;
      }
      grouped[factor].home += clamp(homeDelta, -0.15, 0.15);
      grouped[factor].away += clamp(awayDelta, -0.15, 0.15);
    }
  }
  for (const value of Object.values(grouped)) {
    value.home = clamp(value.home, -0.25, 0.25);
    value.away = clamp(value.away, -0.25, 0.25);
  }
  const conflictGroups = new Map<string, Set<string>>();
  for (const item of evidence) {
    if (!item.conflict_group) continue;
    const types = conflictGroups.get(item.conflict_group) ?? new Set<string>();
    types.add(String(item.observation_type));
    conflictGroups.set(item.conflict_group, types);
  }
  const derivedConflict = [...conflictGroups.values()].some((types) => (
    types.has('return') && (types.has('injury') || types.has('suspension'))
  ));
  return {
    evidenceIds,
    grouped,
    homeDelta: Object.values(grouped).reduce((sum, item) => sum + item.home, 0),
    awayDelta: Object.values(grouped).reduce((sum, item) => sum + item.away, 0),
    conflict: derivedConflict || evidence.some((item) => item.is_conflicted && !item.conflict_group),
    unconfirmedPress: evidence.some((item) => item.source_tier === 'press'),
    pendingMaterial,
  };
};

const objectiveLogRateDelta = (objectives: JsonRecord, parameters: JsonRecord) => {
  const coefficients = record(parameters.objective_state_coefficients);
  let total = 0;
  for (const [objective, rawState] of Object.entries(objectives)) {
    if (typeof rawState !== 'string' || rawState === 'unknown') continue;
    total += numeric(record(coefficients[objective])[rawState], 0);
  }
  return clamp(total, -0.2, 0.2);
};

const loadStructuredContext = async (
  actor: Actor,
  fixture: Fixture,
  parameters: JsonRecord,
  dataCutoff: string,
) => {
  const teamIds = [fixture.home_team_id, fixture.away_team_id];
  const standings = await actor.admin.from('standings_snapshots')
    .select('team_id, objectives, as_of')
    .eq('owner_id', actor.userId)
    .eq('competition_id', fixture.competition_id)
    .eq('season', fixture.season)
    .in('team_id', teamIds)
    .lte('as_of', dataCutoff)
    .order('as_of', { ascending: false })
    .limit(100);
  if (standings.error) throw new HttpError(500, 'standings_context_read_failed', standings.error.message);
  const latestObjectives = new Map<string, { objectives: JsonRecord; asOf: string }>();
  for (const item of standings.data ?? []) {
    if (!latestObjectives.has(item.team_id)) {
      latestObjectives.set(item.team_id, {
        objectives: record(item.objectives),
        asOf: item.as_of,
      });
    }
  }

  const recent = await actor.admin.from('fixtures')
    .select('home_team_id, away_team_id, kickoff_at')
    .eq('owner_id', actor.userId)
    .eq('status', 'finished')
    .lt('kickoff_at', dataCutoff)
    .or(`home_team_id.in.(${teamIds.join(',')}),away_team_id.in.(${teamIds.join(',')})`)
    .order('kickoff_at', { ascending: false })
    .limit(100);
  if (recent.error) throw new HttpError(500, 'schedule_context_read_failed', recent.error.message);
  const kickoff = Date.parse(fixture.kickoff_at);
  const fourteenDaysBefore = kickoff - 14 * 24 * 60 * 60_000;
  const schedule = new Map<string, { lastKickoff: number | null; matches14d: number }>(teamIds.map((id) => [
    id,
    { lastKickoff: null, matches14d: 0 },
  ]));
  for (const match of recent.data ?? []) {
    const playedAt = Date.parse(match.kickoff_at);
    if (!Number.isFinite(playedAt) || playedAt >= kickoff) continue;
    for (const teamId of teamIds) {
      if (match.home_team_id !== teamId && match.away_team_id !== teamId) continue;
      const current = schedule.get(teamId)!;
      if (current.lastKickoff === null || playedAt > current.lastKickoff) current.lastKickoff = playedAt;
      if (playedAt >= fourteenDaysBefore) current.matches14d += 1;
    }
  }
  const homeSchedule = schedule.get(fixture.home_team_id)!;
  const awaySchedule = schedule.get(fixture.away_team_id)!;
  const restDays = (lastKickoff: number | null) => lastKickoff === null
    ? null
    : clamp((kickoff - lastKickoff) / (24 * 60 * 60_000), 0, 30);
  const homeRestDays = restDays(homeSchedule.lastKickoff);
  const awayRestDays = restDays(awaySchedule.lastKickoff);
  const scheduleCoefficients = record(parameters.schedule_context_coefficients);
  const restDifference = homeRestDays === null || awayRestDays === null ? 0 : homeRestDays - awayRestDays;
  const congestionDifference = homeSchedule.matches14d - awaySchedule.matches14d;
  const relativeDelta = parameters.context_enabled === true
    ? clamp(
      numeric(scheduleCoefficients.rest_days_difference, 0) * clamp(restDifference, -7, 7)
        + numeric(scheduleCoefficients.congestion_matches_difference, 0) * clamp(congestionDifference, -5, 5),
      -0.2,
      0.2,
    )
    : 0;
  const homeObjectives = latestObjectives.get(fixture.home_team_id)?.objectives ?? { title: 'unknown', european_places: 'unknown', survival: 'unknown' };
  const awayObjectives = latestObjectives.get(fixture.away_team_id)?.objectives ?? { title: 'unknown', european_places: 'unknown', survival: 'unknown' };
  return {
    objectives: {
      home: homeObjectives,
      away: awayObjectives,
      home_as_of: latestObjectives.get(fixture.home_team_id)?.asOf ?? null,
      away_as_of: latestObjectives.get(fixture.away_team_id)?.asOf ?? null,
    },
    schedule: {
      home_rest_days: homeRestDays,
      away_rest_days: awayRestDays,
      home_matches_last_14_days: homeSchedule.matches14d,
      away_matches_last_14_days: awaySchedule.matches14d,
    },
    deltas: {
      objectives: parameters.context_enabled === true
        ? {
          home: objectiveLogRateDelta(homeObjectives, parameters),
          away: objectiveLogRateDelta(awayObjectives, parameters),
        }
        : { home: 0, away: 0 },
      rest: { home: relativeDelta / 2, away: -relativeDelta / 2 },
    },
  };
};

const confirmedLineups = async (actor: Actor, fixture: Fixture, dataCutoff: string) => {
  const cutoffMs = Date.parse(dataCutoff);
  const freshnessCutoff = new Date(Math.max(
    cutoffMs - 6 * 60 * 60 * 1000,
    Date.parse(fixture.kickoff_at) - 4 * 60 * 60 * 1000,
  )).toISOString();
  const lineups = await actor.admin.from('lineups').select('id, team_id, observed_at')
    .eq('owner_id', actor.userId).eq('fixture_id', fixture.id).eq('lineup_type', 'confirmed')
    .gte('observed_at', freshnessCutoff)
    .lte('observed_at', dataCutoff)
    .order('observed_at', { ascending: false })
    .order('id', { ascending: true });
  if (lineups.error) throw new HttpError(500, 'lineup_read_failed', lineups.error.message);
  const latest = new Map<string, string>();
  for (const lineup of lineups.data ?? []) {
    if (!latest.has(lineup.team_id)) latest.set(lineup.team_id, lineup.id);
  }
  const ids = [latest.get(fixture.home_team_id), latest.get(fixture.away_team_id)].filter(Boolean) as string[];
  if (ids.length !== 2) return { confirmed: false, lineupIds: latest };
  const players = await actor.admin.from('lineup_players').select('lineup_id')
    .eq('owner_id', actor.userId).in('lineup_id', ids).eq('is_starter', true);
  if (players.error) throw new HttpError(500, 'lineup_players_read_failed', players.error.message);
  const counts = new Map<string, number>();
  for (const player of players.data ?? []) counts.set(player.lineup_id, (counts.get(player.lineup_id) ?? 0) + 1);
  return {
    confirmed: ids.every((id) => counts.get(id) === 11),
    lineupIds: latest,
  };
};

const lineupRateScenarios = async (
  actor: Actor,
  fixture: Fixture,
  parameters: JsonRecord,
  confirmed: Awaited<ReturnType<typeof confirmedLineups>>,
  dataCutoff: string,
): Promise<LineupRateScenario[]> => {
  const coefficient = parameters.context_enabled === true
    ? numeric(parameters.lineup_strength_coefficient, 0)
    : 0;
  let rows: Array<{
    id: string;
    team_id: string;
    scenario_probability: number | null;
    observed_at: string;
  }> = [];
  if (confirmed.confirmed) {
    rows = [...confirmed.lineupIds.entries()].map(([teamId, id]) => ({
      id,
      team_id: teamId,
      scenario_probability: 1,
      observed_at: new Date().toISOString(),
    }));
  } else {
    const scenarioRows = await actor.admin.from('lineups')
      .select('id, team_id, scenario_probability, observed_at')
      .eq('owner_id', actor.userId)
      .eq('fixture_id', fixture.id)
      .eq('lineup_type', 'scenario')
      .in('source_tier', ['official', 'structured'])
      .gte('observed_at', new Date(Date.parse(dataCutoff) - 72 * 60 * 60_000).toISOString())
      .lte('observed_at', dataCutoff)
      .order('observed_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(24);
    if (scenarioRows.error) throw new HttpError(500, 'lineup_scenarios_read_failed', scenarioRows.error.message);
    const newestByTeam = new Map<string, number>();
    for (const row of scenarioRows.data ?? []) {
      const observed = Date.parse(row.observed_at);
      if (!newestByTeam.has(row.team_id) || observed > newestByTeam.get(row.team_id)!) {
        newestByTeam.set(row.team_id, observed);
      }
    }
    rows = (scenarioRows.data ?? []).filter((row) => (
      Date.parse(row.observed_at) >= (newestByTeam.get(row.team_id) ?? 0) - 15 * 60_000
    ));
  }
  if (!rows.length) return [{ id: 'lineup-neutral', weight: 1, homeLogRateDelta: 0, awayLogRateDelta: 0 }];
  const players = await actor.admin.from('lineup_players')
    .select('lineup_id, strength_delta')
    .eq('owner_id', actor.userId)
    .in('lineup_id', rows.map((row) => row.id))
    .eq('is_starter', true);
  if (players.error) throw new HttpError(500, 'lineup_strength_read_failed', players.error.message);
  const strengthByLineup = new Map<string, number>();
  for (const player of players.data ?? []) {
    strengthByLineup.set(
      player.lineup_id,
      (strengthByLineup.get(player.lineup_id) ?? 0) + numeric(player.strength_delta, 0),
    );
  }
  const teamRows = (teamId: string) => rows.filter((row) => row.team_id === teamId);
  const normalize = (items: typeof rows) => {
    if (!items.length) return [{ id: 'neutral', weight: 1, delta: 0 }];
    const total = items.reduce((sum, item) => sum + Math.max(0, numeric(item.scenario_probability, 0)), 0);
    return items.map((item) => ({
      id: item.id,
      weight: total > 0 ? Math.max(0, numeric(item.scenario_probability, 0)) / total : 1 / items.length,
      delta: clamp(coefficient * (strengthByLineup.get(item.id) ?? 0), -0.2, 0.2),
    }));
  };
  const home = normalize(teamRows(fixture.home_team_id));
  const away = normalize(teamRows(fixture.away_team_id));
  return home.flatMap((homeScenario) => away.map((awayScenario) => ({
    id: `lineup:${homeScenario.id}:${awayScenario.id}`,
    weight: homeScenario.weight * awayScenario.weight,
    homeLogRateDelta: homeScenario.delta,
    awayLogRateDelta: awayScenario.delta,
  })));
};

const latestOdds = async (actor: Actor, fixture: Fixture, dataCutoff: string) => {
  const cutoffMs = Date.parse(dataCutoff);
  const cutoff = new Date(cutoffMs - 2 * 60 * 60 * 1000).toISOString();
  const response = await actor.admin.from('odds_snapshots')
    .select('id, market, outcome, decimal_odds, observed_at, bookmaker, provider')
    .eq('owner_id', actor.userId).eq('fixture_id', fixture.id)
    .gte('observed_at', cutoff)
    .lte('observed_at', dataCutoff)
    .order('observed_at', { ascending: false })
    .order('decimal_odds', { ascending: false })
    .order('bookmaker', { ascending: true })
    .order('id', { ascending: true });
  if (response.error) throw new HttpError(500, 'odds_read_failed', response.error.message);
  const result = new Map<string, { id: string; odds: number; observedAt: string; bookmaker: string; provider: string }>();
  for (const item of response.data ?? []) {
    const key = `${item.market}:${item.outcome}`;
    const ageMinutes = (cutoffMs - Date.parse(item.observed_at)) / 60_000;
    if (ageMinutes > 30) continue;
    const existing = result.get(key);
    const itemOdds = numeric(item.decimal_odds);
    const stableSource = `${item.bookmaker}:${item.provider}:${item.id}`;
    const existingSource = existing ? `${existing.bookmaker}:${existing.provider}:${existing.id}` : '';
    if (!existing || itemOdds > existing.odds || (itemOdds === existing.odds && stableSource < existingSource)) {
      result.set(key, {
        id: item.id,
        odds: itemOdds,
        observedAt: item.observed_at,
        bookmaker: item.bookmaker,
        provider: item.provider,
      });
    }
  }
  return result;
};

const apiFootballProviderHealth = async (actor: Actor, fixture: Fixture, dataCutoff: string) => {
  const response = await actor.admin.from('provider_payloads')
    .select('id, endpoint, fetched_at, http_status, is_stale, data_state')
    .eq('owner_id', actor.userId)
    .eq('fixture_id', fixture.id)
    .eq('provider', 'api_football')
    .in('endpoint', ['fixtures', 'injuries', 'odds', 'fixtures/lineups'])
    .lte('fetched_at', dataCutoff)
    .order('fetched_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(40);
  if (response.error) throw new HttpError(500, 'provider_health_read_failed', response.error.message);
  const latest = new Map<string, {
    fetched_at: string;
    http_status: number;
    is_stale: boolean;
    data_state: string;
  }>();
  for (const item of response.data ?? []) {
    if (!latest.has(item.endpoint)) latest.set(item.endpoint, item);
  }
  const endpoints = Object.fromEntries([...latest.entries()].map(([endpoint, item]) => [endpoint, {
    fetched_at: item.fetched_at,
    http_status: item.http_status,
    state: item.is_stale || item.http_status !== 200
      ? 'stale'
      : item.data_state === 'complete' ? 'fresh' : item.data_state,
  }]));
  const requiresApiFootball = numeric(record(fixture.provider_ids).api_football, 0) > 0;
  const requiredEndpoints = requiresApiFootball
    ? ['fixtures', 'injuries', 'odds', 'fixtures/lineups']
    : [];
  return {
    blocking: requiredEndpoints.some((endpoint) => !latest.has(endpoint))
      || [...latest.values()].some((item) => (
        item.is_stale || item.http_status !== 200 || item.data_state !== 'complete'
      )),
    endpoints,
    missing_endpoints: requiredEndpoints.filter((endpoint) => !latest.has(endpoint)),
  };
};

const qualificationContext = async (
  actor: Actor,
  fixture: Fixture,
  competitionCode: string,
  regulationGrid: number[][],
  lambdaHome: number,
  lambdaAway: number,
) => {
  if (!['UCL', 'UEL', 'UECL'].includes(competitionCode)) {
    return { available: false, reason: 'No aplica a esta competición.' };
  }
  const stage = fixture.stage?.trim() ?? '';
  const normalizedStage = stage.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!stage || normalizedStage === 'final' || !/(round|last|quarter|semi|playoff|knockout)/i.test(stage)) {
    return { available: false, reason: 'No hay una eliminatoria de vuelta identificada.' };
  }
  if (!fixture.rule_version_id) {
    return { available: false, reason: 'Falta una versión oficial de reglas para la eliminatoria.' };
  }
  const rule = await actor.admin.from('competition_rule_versions')
    .select('rules, verification_status')
    .eq('owner_id', actor.userId)
    .eq('id', fixture.rule_version_id)
    .maybeSingle();
  if (rule.error) throw new HttpError(500, 'qualification_rules_read_failed', rule.error.message);
  const knockout = record(record(rule.data?.rules).knockout);
  if (rule.data?.verification_status !== 'official_verified'
      || knockout.two_legs !== true
      || knockout.away_goals !== false) {
    return { available: false, reason: 'Las reglas de esta eliminatoria aún no están verificadas.' };
  }
  const previous = await actor.admin.from('fixtures')
    .select('id, stage, kickoff_at, home_score, away_score')
    .eq('owner_id', actor.userId)
    .eq('competition_id', fixture.competition_id)
    .eq('season', fixture.season)
    .eq('home_team_id', fixture.away_team_id)
    .eq('away_team_id', fixture.home_team_id)
    .eq('status', 'finished')
    .not('home_score', 'is', null)
    .not('away_score', 'is', null)
    .lt('kickoff_at', fixture.kickoff_at)
    .order('kickoff_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previous.error) throw new HttpError(500, 'qualification_leg_read_failed', previous.error.message);
  if (!previous.data
      || String(previous.data.stage ?? '').trim().toLowerCase() !== stage.toLowerCase()
      || Date.parse(previous.data.kickoff_at) < Date.parse(fixture.kickoff_at) - 90 * 24 * 60 * 60_000) {
    return { available: false, reason: 'No se encontró una ida verificada de la misma eliminatoria.' };
  }
  const aggregateHomeBefore = numeric(previous.data.away_score, -1);
  const aggregateAwayBefore = numeric(previous.data.home_score, -1);
  if (aggregateHomeBefore < 0 || aggregateAwayBefore < 0) {
    return { available: false, reason: 'El marcador global no está completo.' };
  }
  const probabilities = calculateSecondLegQualification(
    regulationGrid,
    lambdaHome,
    lambdaAway,
    aggregateHomeBefore,
    aggregateAwayBefore,
  );
  return {
    available: true,
    home: probabilities.home,
    away: probabilities.away,
    decided_in_extra_time_or_penalties: probabilities.decidedInExtraTimeOrPenalties,
    aggregate_before: { home: aggregateHomeBefore, away: aggregateAwayBefore },
    first_leg_fixture_id: previous.data.id,
    rules: { two_legs: true, away_goals: false },
  };
};

const marketParts = (key: MarketKey) => {
  const [market, outcome] = key.split(':');
  return { market, outcome };
};

export const generateFixturePrediction = async (actor: Actor, fixtureId: string) => {
  const fixtureResponse = await actor.admin.from('fixtures').select('*')
    .eq('owner_id', actor.userId).eq('id', fixtureId).single();
  if (fixtureResponse.error) throw new HttpError(404, 'fixture_not_found', 'El partido no existe');
  const fixture = fixtureResponse.data as Fixture;
  if (!['scheduled', 'postponed'].includes(fixture.status) || Date.parse(fixture.kickoff_at) <= Date.now()) {
    return { skipped: true, reason: 'fixture_not_pre_match', snapshotsWritten: 0 };
  }
  const minutesToKickoff = (Date.parse(fixture.kickoff_at) - Date.now()) / 60_000;
  if (minutesToKickoff > 24 * 60) {
    return { skipped: true, reason: 'prediction_window_not_reached', snapshotsWritten: 0 };
  }

  const modelResponse = await actor.admin.from('model_versions').select('*')
    .eq('owner_id', actor.userId).in('status', ['champion', 'baseline']);
  if (modelResponse.error) throw new HttpError(500, 'model_read_failed', modelResponse.error.message);
  const model = modelResponse.data?.find((item) => item.status === 'champion')
    ?? modelResponse.data?.find((item) => item.status === 'baseline');
  if (!model) return { skipped: true, reason: 'model_not_configured', snapshotsWritten: 0 };
  const competitionResponse = await actor.admin.from('competitions').select('code')
    .eq('owner_id', actor.userId).eq('id', fixture.competition_id).single();
  if (competitionResponse.error) throw new HttpError(500, 'competition_read_failed', competitionResponse.error.message);
  const competitionCode = String(competitionResponse.data.code);
  const activationResponse = await actor.admin.from('competition_recommendation_activation')
    .select('enabled').eq('owner_id', actor.userId)
    .eq('competition_id', fixture.competition_id).maybeSingle();
  if (activationResponse.error) throw new HttpError(500, 'activation_read_failed', activationResponse.error.message);
  const competitionActivated = activationResponse.data?.enabled === true;
  const parameters = record(model.parameters);
  const dataCutoff = new Date().toISOString();
  const historyResponse = await actor.admin.from('fixtures')
    .select('id, home_team_id, away_team_id, home_score, away_score, kickoff_at, result_available_at')
    .eq('owner_id', actor.userId).eq('competition_id', fixture.competition_id)
    .eq('status', 'finished').lt('kickoff_at', dataCutoff)
    .lte('result_available_at', dataCutoff)
    .not('home_score', 'is', null).not('away_score', 'is', null)
    .order('kickoff_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(600);
  if (historyResponse.error) throw new HttpError(500, 'history_read_failed', historyResponse.error.message);
  const history = (historyResponse.data ?? []).map((item) => ({
    ...item,
    home_score: numeric(item.home_score),
    away_score: numeric(item.away_score),
  })) as HistoricalFixture[];
  const lambda = estimateLambdas(history, fixture, parameters, competitionCode);
  const context = await loadContext(actor, fixture, parameters, dataCutoff);
  const structuredContext = await loadStructuredContext(actor, fixture, parameters, dataCutoff);
  context.grouped.objectives.home = clamp(
    context.grouped.objectives.home + structuredContext.deltas.objectives.home,
    -0.25,
    0.25,
  );
  context.grouped.objectives.away = clamp(
    context.grouped.objectives.away + structuredContext.deltas.objectives.away,
    -0.25,
    0.25,
  );
  context.grouped.rest.home = clamp(
    context.grouped.rest.home + structuredContext.deltas.rest.home,
    -0.25,
    0.25,
  );
  context.grouped.rest.away = clamp(
    context.grouped.rest.away + structuredContext.deltas.rest.away,
    -0.25,
    0.25,
  );
  context.homeDelta = Object.values(context.grouped).reduce((sum, item) => sum + item.home, 0);
  context.awayDelta = Object.values(context.grouped).reduce((sum, item) => sum + item.away, 0);
  const confirmedLineupState = await confirmedLineups(actor, fixture, dataCutoff);
  const hasOfficialLineup = confirmedLineupState.confirmed;
  const lineupScenarios = await lineupRateScenarios(
    actor,
    fixture,
    parameters,
    confirmedLineupState,
    dataCutoff,
  );
  const usesLineupMixture = hasOfficialLineup
    || lineupScenarios.some((scenario) => scenario.id !== 'lineup-neutral');
  if (usesLineupMixture) {
    // Rotation evidence informs construction/weighting of lineup scenarios;
    // it is not also added as an independent probability adjustment.
    context.grouped.lineup = { home: 0, away: 0 };
    context.homeDelta = Object.values(context.grouped).reduce((sum, item) => sum + item.home, 0);
    context.awayDelta = Object.values(context.grouped).reduce((sum, item) => sum + item.away, 0);
  }
  const odds = await latestOdds(actor, fixture, dataCutoff);
  const providerHealth = await apiFootballProviderHealth(actor, fixture, dataCutoff);
  const horizon = hasOfficialLineup ? 'official_lineup' : minutesToKickoff <= 6 * 60 ? 't6h' : 't24h';
  const rho = lambda.rho;
  const contextualHomeWithoutLineup = lambda.home * Math.exp(context.homeDelta);
  const contextualAwayWithoutLineup = lambda.away * Math.exp(context.awayDelta);
  const centralScenarios: Scenario[] = lineupScenarios.map((scenario) => ({
    id: scenario.id,
    weight: scenario.weight,
    home: contextualHomeWithoutLineup * Math.exp(scenario.homeLogRateDelta),
    away: contextualAwayWithoutLineup * Math.exp(scenario.awayLogRateDelta),
  }));
  const centralGrid = mixedScoreGrid(centralScenarios, rho);
  const scenarioWeight = centralScenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  const contextualHome = centralScenarios.reduce((sum, scenario) => sum + scenario.weight * scenario.home, 0) / scenarioWeight;
  const contextualAway = centralScenarios.reduce((sum, scenario) => sum + scenario.weight * scenario.away, 0) / scenarioWeight;
  const baseProbabilities = markets(scoreGrid(lambda.home, lambda.away, rho));
  const centralProbabilities = markets(centralGrid);
  const competitionParameters = record(record(parameters.competition_models)[competitionCode]);
  const uncertaintySource = Object.keys(competitionParameters).length ? competitionParameters : parameters;
  const configuredUncertainty = Number(uncertaintySource.log_rate_uncertainty_sd);
  const uncertaintyMethod = String(
    uncertaintySource.uncertainty_method ?? parameters.uncertainty_method ?? '',
  );
  const uncertaintyReady = uncertaintyMethod === 'poisson_exposure_qmc_v1'
    && Number.isFinite(configuredUncertainty)
    && configuredUncertainty > 0;
  const supportUncertainty = 0.7 / Math.sqrt(
    Math.max(1, Math.min(lambda.homeMatches, lambda.awayMatches)) + 2,
  );
  const logRateUncertainty = clamp(
    Math.max(uncertaintyReady ? configuredUncertainty : 0, supportUncertainty)
      * (context.unconfirmedPress ? 1.25 : 1),
    0.06,
    0.4,
  );
  const perturbations = deterministicRatePerturbations(logRateUncertainty, 81);
  const scenarios: Scenario[] = centralScenarios.flatMap((lineup) => perturbations.map((perturbation) => ({
    id: `${lineup.id}:${perturbation.id}`,
    weight: lineup.weight * perturbation.weight,
    home: lineup.home * perturbation.homeMultiplier,
    away: lineup.away * perturbation.awayMultiplier,
  })));
  const scenarioMarkets = scenarios.map((scenario) => ({
    ...scenario,
    probabilities: markets(scoreGrid(scenario.home, scenario.away, rho)),
  }));
  const dataSufficient = history.length >= 50 && lambda.homeMatches >= 5 && lambda.awayMatches >= 5;
  const materialConflict = context.conflict || context.unconfirmedPress || context.pendingMaterial;
  const modelEligible = model.status === 'champion' && lambda.contractValid;
  const recommendationsEnabled = modelEligible && uncertaintyReady && competitionActivated;
  const keys = Object.keys(centralProbabilities) as MarketKey[];
  const drafts = keys.map((key) => {
    const samples = scenarioMarkets.map((scenario) => ({ value: scenario.probabilities[key], weight: scenario.weight }));
    const intervalLow = Math.min(centralProbabilities[key], weightedQuantile(samples, 0.05));
    const intervalHigh = Math.max(centralProbabilities[key], weightedQuantile(samples, 0.95));
    const conservativeProbability = weightedQuantile(samples, 0.1);
    const quote = odds.get(key) ?? null;
    const probabilityPositiveEv = quote
      ? samples.filter((sample) => sample.value * quote.odds - 1 > 0).reduce((sum, sample) => sum + sample.weight, 0)
      : null;
    const lowerBoundEdge = quote ? conservativeProbability * quote.odds - 1 : null;
    const marketEligible = !key.startsWith('btts:');
    const gates = {
      model: recommendationsEnabled,
      market: marketEligible,
      data: dataSufficient,
      lineup: hasOfficialLineup,
      conflicts: !materialConflict,
      odds: quote !== null,
      provider_freshness: !providerHealth.blocking,
    };
    const structuralReady = Object.values(gates).every(Boolean);
    const candidate = structuralReady
      && (lowerBoundEdge ?? -1) >= 0.02
      && (probabilityPositiveEv ?? 0) >= 0.9;
    const reasons = [
      model.status !== 'champion' && 'model_not_promoted',
      model.status === 'champion' && !lambda.contractValid && 'model_contract_invalid',
      modelEligible && !uncertaintyReady && 'uncertainty_contract_missing',
      modelEligible && uncertaintyReady && !competitionActivated && 'competition_shadow_gate_not_met',
      !marketEligible && 'informational_market',
      !dataSufficient && 'insufficient_data',
      !hasOfficialLineup && 'official_lineup_missing',
      materialConflict && 'material_context_conflict',
      context.pendingMaterial && 'context_review_pending',
      !quote && 'fresh_odds_missing',
      providerHealth.blocking && 'provider_data_stale',
      structuralReady && (lowerBoundEdge ?? -1) < 0.02 && 'conservative_edge_below_2pct',
      structuralReady && (probabilityPositiveEv ?? 0) < 0.9 && 'positive_ev_confidence_below_90pct',
    ].filter(Boolean);
    return {
      key,
      quote,
      intervalLow,
      intervalHigh,
      conservativeProbability,
      probabilityPositiveEv,
      lowerBoundEdge,
      candidate,
      decision: candidate ? 'paper_candidate' : structuralReady ? 'no_bet' : 'informational',
      reasons,
    };
  });
  const winner = drafts.filter((draft) => draft.candidate)
    .sort((left, right) => (right.lowerBoundEdge ?? -1) - (left.lowerBoundEdge ?? -1))[0]?.key;
  for (const draft of drafts) {
    if (draft.candidate && draft.key !== winner) {
      draft.candidate = false;
      draft.decision = 'no_bet';
      draft.reasons.push('not_best_candidate_for_fixture');
    }
  }
  const candidate = drafts.find((draft) => draft.candidate && draft.key === winner);

  const impactsFor = (key: MarketKey) => Object.entries(context.grouped).map(([factor, delta]) => {
    const without = factor === 'lineup' && usesLineupMixture
      ? markets(scoreGrid(contextualHomeWithoutLineup, contextualAwayWithoutLineup, rho))[key]
      : markets(mixedScoreGrid(centralScenarios.map((scenario) => ({
        ...scenario,
        home: scenario.home / Math.exp(delta.home),
        away: scenario.away / Math.exp(delta.away),
      })), rho))[key];
    return { factor, value: centralProbabilities[key] - without, method: 'leave_one_group_out' };
  });
  const scoreSummary = { top: topScores(centralGrid), max_goals: 10 };
  const qualification = await qualificationContext(
    actor,
    fixture,
    competitionCode,
    centralGrid,
    contextualHome,
    contextualAway,
  );
  const normalizedOdds = [...odds.entries()]
    .map(([key, quote]) => ({ key, ...quote }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const inputHash = await predictionInputHash({
    contract: 'prediction-input-v1',
    engine_version: PREDICTION_ENGINE_VERSION,
    fixture: {
      id: fixture.id,
      competition_id: fixture.competition_id,
      home_team_id: fixture.home_team_id,
      away_team_id: fixture.away_team_id,
      kickoff_at: fixture.kickoff_at,
      status: fixture.status,
      season: fixture.season,
      stage: fixture.stage ?? null,
      rule_version_id: fixture.rule_version_id ?? null,
      aggregate_context: fixture.aggregate_context,
    },
    competition_code: competitionCode,
    recommendation_activation: competitionActivated,
    model: {
      id: model.id,
      version: model.version,
      status: model.status,
      parameters,
    },
    horizon,
    history,
    lambda,
    context: {
      grouped: context.grouped,
      evidence_ids: [...context.evidenceIds].sort(),
      conflict: context.conflict,
      unconfirmed_press: context.unconfirmedPress,
      pending_material_review: context.pendingMaterial,
    },
    structured_context: structuredContext,
    official_lineup: hasOfficialLineup,
    lineup_scenarios: [...lineupScenarios].sort((left, right) => left.id.localeCompare(right.id)),
    odds: normalizedOdds,
    provider_health: providerHealth,
    uncertainty: {
      method: uncertaintyMethod || 'unvalidated_support_fallback',
      samples: perturbations.length,
      log_rate_standard_deviation: logRateUncertainty,
      validated_contract: uncertaintyReady,
    },
    qualification,
  });

  const reconcileRecommendation = async (snapshotRows: PredictionSnapshotReference[]) => {
    const anchorSnapshot = [...snapshotRows]
      .sort((left, right) => `${left.market}:${left.outcome}`.localeCompare(`${right.market}:${right.outcome}`))[0];
    if (!anchorSnapshot) {
      throw new HttpError(500, 'prediction_snapshot_set_empty', 'El corte no contiene snapshots');
    }
    const candidateSnapshot = candidate
      ? snapshotRows.find((row) => `${row.market}:${row.outcome}` === candidate.key)
      : undefined;
    if (candidate && !candidateSnapshot) {
      throw new HttpError(500, 'candidate_snapshot_missing', 'El corte no contiene el mercado candidato esperado');
    }

    const reconciled = await actor.admin.rpc('reconcile_fixture_recommendation', {
      p_owner_id: actor.userId,
      p_anchor_snapshot_id: anchorSnapshot.id,
      p_candidate_snapshot_id: candidateSnapshot?.id ?? null,
    });
    if (reconciled.error) {
      throw new HttpError(500, 'recommendation_reconciliation_failed', reconciled.error.message);
    }
  };

  const latestSnapshotResponse = await actor.admin.from('prediction_snapshots')
    .select('id, market, outcome, decision, input_hash, generation_hash, data_cutoff')
    .eq('owner_id', actor.userId)
    .eq('fixture_id', fixture.id)
    .eq('model_version_id', model.id)
    .eq('horizon', horizon)
    .order('data_cutoff', { ascending: false })
    .order('market', { ascending: true })
    .order('outcome', { ascending: true })
    .limit(keys.length);
  if (latestSnapshotResponse.error) {
    throw new HttpError(500, 'prediction_snapshot_read_failed', latestSnapshotResponse.error.message);
  }
  const latestCutoff = latestSnapshotResponse.data?.[0]?.data_cutoff;
  const latestSnapshots = (latestSnapshotResponse.data ?? []).filter((row) => row.data_cutoff === latestCutoff);
  if (latestSnapshots.length > 0) {
    const existingKeys = new Set(latestSnapshots.map((row) => `${row.market}:${row.outcome}`));
    if (latestSnapshots.length !== keys.length || !keys.every((key) => existingKeys.has(key))) {
      throw new HttpError(500, 'prediction_snapshot_set_incomplete', 'El corte inmutable está incompleto y requiere revisión');
    }
  }
  if (latestSnapshots[0]?.input_hash === inputHash) {
    await reconcileRecommendation(latestSnapshots as PredictionSnapshotReference[]);
    return {
      skipped: true,
      reason: 'inputs_unchanged',
      fixtureId: fixture.id,
      horizon,
      modelVersion: model.version,
      modelStatus: model.status,
      snapshotsWritten: 0,
    };
  }
  const previousAnchor = [...latestSnapshots]
    .sort((left, right) => `${left.market}:${left.outcome}`.localeCompare(`${right.market}:${right.outcome}`))[0]?.id
    ?? 'genesis';
  const generationHash = await predictionGenerationHash({
    engineVersion: PREDICTION_ENGINE_VERSION,
    fixtureId: fixture.id,
    modelVersionId: model.id,
    horizon,
    previousSnapshotAnchor: previousAnchor,
    inputHash,
  });

  const featureWrite = await actor.admin.from('context_feature_snapshots').insert({
    owner_id: actor.userId,
    fixture_id: fixture.id,
    horizon,
    data_cutoff: dataCutoff,
    input_hash: inputHash,
    generation_hash: generationHash,
    features: {
      history_matches: history.length,
      home_team_home_matches: lambda.homeMatches,
      away_team_away_matches: lambda.awayMatches,
      league_home_goals: lambda.leagueHome,
      league_away_goals: lambda.leagueAway,
      context_log_rate_deltas: context.grouped,
      objective_states: structuredContext.objectives,
      schedule: structuredContext.schedule,
      lineup_scenarios: lineupScenarios,
      official_lineup: hasOfficialLineup,
    },
    evidence_ids: context.evidenceIds,
    has_material_conflict: materialConflict,
    data_quality: {
      status: dataSufficient ? 'sufficient' : 'low_coverage',
      model_status: model.status,
      uncertainty_method: uncertaintyMethod || 'unvalidated_support_fallback',
      uncertainty_samples: perturbations.length,
      log_rate_uncertainty: logRateUncertainty,
      uncertainty_contract_valid: uncertaintyReady,
      unconfirmed_press: context.unconfirmedPress,
      pending_material_review: context.pendingMaterial,
      objective_data_available: structuredContext.objectives.home_as_of !== null
        && structuredContext.objectives.away_as_of !== null,
      schedule_data_available: structuredContext.schedule.home_rest_days !== null
        && structuredContext.schedule.away_rest_days !== null,
      input_contract: 'prediction-input-v1',
      engine_version: PREDICTION_ENGINE_VERSION,
      provider_health: providerHealth,
    },
  }).select('id, data_cutoff').single();
  let featureSnapshotId: string;
  let snapshotDataCutoff = dataCutoff;
  if (featureWrite.error?.code === '23505') {
    const existingFeature = await actor.admin.from('context_feature_snapshots')
      .select('id, data_cutoff')
      .eq('owner_id', actor.userId)
      .eq('fixture_id', fixture.id)
      .eq('horizon', horizon)
      .eq('generation_hash', generationHash)
      .single();
    if (existingFeature.error) {
      throw new HttpError(500, 'feature_snapshot_read_failed', existingFeature.error.message);
    }
    featureSnapshotId = existingFeature.data.id;
    snapshotDataCutoff = existingFeature.data.data_cutoff;
  } else if (featureWrite.error) {
    throw new HttpError(500, 'feature_snapshot_write_failed', featureWrite.error.message);
  } else {
    featureSnapshotId = featureWrite.data.id;
    snapshotDataCutoff = featureWrite.data.data_cutoff;
  }

  const rows = drafts.map((draft) => {
    const { market, outcome } = marketParts(draft.key);
    return {
      owner_id: actor.userId,
      fixture_id: fixture.id,
      model_version_id: model.id,
      feature_snapshot_id: featureSnapshotId,
      market,
      outcome,
      horizon,
      lambda_home: contextualHome,
      lambda_away: contextualAway,
      probability_base: baseProbabilities[draft.key],
      probability_contextual: centralProbabilities[draft.key],
      interval_low: draft.intervalLow,
      interval_high: draft.intervalHigh,
      fair_odds: centralProbabilities[draft.key] > 0 ? 1 / centralProbabilities[draft.key] : null,
      offered_odds: draft.quote?.odds ?? null,
      edge: draft.quote ? centralProbabilities[draft.key] * draft.quote.odds - 1 : null,
      lower_bound_edge: draft.lowerBoundEdge,
      probability_positive_ev: draft.probabilityPositiveEv,
      impacts: impactsFor(draft.key),
      score_distribution: scoreSummary,
      qualification_probabilities: qualification,
      reasons: draft.reasons,
      data_cutoff: snapshotDataCutoff,
      input_hash: inputHash,
      generation_hash: generationHash,
      odds_observed_at: draft.quote?.observedAt ?? null,
      context_conflict: materialConflict,
      data_quality: {
        status: dataSufficient ? 'sufficient' : 'low_coverage',
        history_matches: history.length,
        source_freshness: providerHealth.blocking ? 'provider_stale' : draft.quote ? 'fresh' : 'odds_unavailable',
        model_status: model.status,
        bookmaker: draft.quote?.bookmaker ?? null,
        odds_provider: draft.quote?.provider ?? null,
        provider_health: providerHealth,
        pending_material_review: context.pendingMaterial,
        input_contract: 'prediction-input-v1',
        engine_version: PREDICTION_ENGINE_VERSION,
      },
      decision: draft.decision,
    };
  });
  const inserted = await actor.admin.from('prediction_snapshots').insert(rows).select('id, market, outcome, decision');
  if (inserted.error?.code === '23505') {
    const concurrent = await actor.admin.from('prediction_snapshots')
      .select('id, market, outcome, decision')
      .eq('owner_id', actor.userId)
      .eq('fixture_id', fixture.id)
      .eq('model_version_id', model.id)
      .eq('horizon', horizon)
      .eq('generation_hash', generationHash);
    const concurrentKeys = new Set((concurrent.data ?? []).map((row) => `${row.market}:${row.outcome}`));
    if (concurrent.error || !keys.every((key) => concurrentKeys.has(key))) {
      throw new HttpError(
        500,
        'prediction_snapshot_race_failed',
        concurrent.error?.message ?? 'El corte concurrente quedó incompleto',
      );
    }
    await reconcileRecommendation(concurrent.data as PredictionSnapshotReference[]);
    return {
      skipped: true,
      reason: 'inputs_unchanged',
      fixtureId: fixture.id,
      horizon,
      modelVersion: model.version,
      modelStatus: model.status,
      snapshotsWritten: 0,
    };
  }
  if (inserted.error) throw new HttpError(500, 'prediction_snapshot_write_failed', inserted.error.message);
  await reconcileRecommendation(inserted.data as PredictionSnapshotReference[]);
  return {
    skipped: false,
    fixtureId: fixture.id,
    horizon,
    modelVersion: model.version,
    modelStatus: model.status,
    snapshotsWritten: rows.length,
    candidate: winner ?? null,
  };
};
