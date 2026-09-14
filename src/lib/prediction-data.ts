import { supabase } from './supabase';
import type { ManualBetInput } from './ledger';

type DatabaseRow = Record<string, unknown>;

export type ProbabilitySet = {
  home: number | null;
  draw: number | null;
  away: number | null;
  over25: number | null;
  under25: number | null;
  bttsYes: number | null;
};

export type ProbabilityInterval = {
  low: number;
  high: number;
};

export type ProbabilityIntervalSet = {
  home: ProbabilityInterval | null;
  draw: ProbabilityInterval | null;
  away: ProbabilityInterval | null;
  over25: ProbabilityInterval | null;
  under25: ProbabilityInterval | null;
  bttsYes: ProbabilityInterval | null;
};

export type ContextImpact = {
  key: string;
  label: string;
  value: number;
};

export type RecommendationSummary = {
  id: string;
  market: string;
  outcome: string;
  selection: string;
  offeredOdds: number | null;
  fairOdds: number | null;
  edge: number | null;
  status: string;
};

export type PredictionPricing = {
  offeredOdds: number | null;
  fairOdds: number | null;
  edge: number | null;
  conservativeEdge: number | null;
  probabilityEvPositive: number | null;
};

export type LineupSummary = {
  id: string;
  teamId: string;
  teamName: string;
  type: string;
  formation: string | null;
  sourceTier: string;
  observedAt: string | null;
  starters: string[];
};

export type AvailabilitySummary = {
  id: string;
  teamId: string;
  teamName: string;
  playerName: string;
  status: string;
  probabilityAvailable: number | null;
  asOf: string | null;
};

export type ScoreProbability = {
  home: number;
  away: number;
  probability: number;
};

export type CompetitiveContext = {
  homeObjectives: Record<string, string>;
  awayObjectives: Record<string, string>;
  homeObjectivesAsOf: string | null;
  awayObjectivesAsOf: string | null;
  homeRestDays: number | null;
  awayRestDays: number | null;
  homeMatchesLast14Days: number | null;
  awayMatchesLast14Days: number | null;
};

export type PredictionListItem = {
  id: string;
  fixtureId: string;
  competitionCode: string;
  competitionName: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: string | null;
  stage: string | null;
  fixtureStatus: string;
  horizon: string;
  cutoffAt: string | null;
  modelVersion: string;
  lambdaHome: number | null;
  lambdaAway: number | null;
  base: ProbabilitySet;
  contextual: ProbabilitySet;
  intervals: ProbabilityIntervalSet;
  impacts: ContextImpact[];
  traceLabel: string;
  pricing: PredictionPricing;
  decision: string;
  dataQuality: string;
  sourceFreshness: string;
  oddsObservedAt: string | null;
  recommendation: RecommendationSummary | null;
  topScores: ScoreProbability[];
  qualification: DatabaseRow | null;
  competitiveContext: CompetitiveContext | null;
  reasons: string[];
  evidenceIds: string[];
  lineups: LineupSummary[];
  availability: AvailabilitySummary[];
  rawPrediction: DatabaseRow;
  rawFixture: DatabaseRow;
};

export type ContextObservationItem = {
  id: string;
  fixtureId: string | null;
  fixtureLabel: string;
  affectedEntity: string;
  type: string;
  summary: string;
  authority: string;
  confidence: number | null;
  sourceUrl: string | null;
  reviewStatus: string;
  publishedAt: string | null;
  fetchedAt: string | null;
  isConflicted: boolean;
};

export type PredictionDataResult = {
  predictions: PredictionListItem[];
  warnings: string[];
};

export type ContextDataResult = {
  observations: ContextObservationItem[];
  warnings: string[];
};

const EMPTY_PROBABILITIES: ProbabilitySet = {
  home: null,
  draw: null,
  away: null,
  over25: null,
  under25: null,
  bttsYes: null,
};

const EMPTY_INTERVALS: ProbabilityIntervalSet = {
  home: null,
  draw: null,
  away: null,
  over25: null,
  under25: null,
  bttsYes: null,
};

const IMPACT_LABELS: Record<string, string> = {
  objectives: 'Objetivos competitivos',
  objective: 'Objetivos competitivos',
  competitive_status: 'Objetivos competitivos',
  rest: 'Descanso',
  fatigue: 'Descanso y fatiga',
  congestion: 'Congestión',
  availability: 'Bajas',
  injuries: 'Bajas',
  lineup: 'Alineación',
  lineups: 'Alineación',
};

const asRecord = (value: unknown): DatabaseRow | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as DatabaseRow;
};

const pick = (row: DatabaseRow | null | undefined, keys: string[]): unknown => {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const asBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  return value === 1 || value === '1' || value === 'true';
};

const normalizeProbability = (value: unknown): number | null => {
  const number = asNumber(value);
  if (number === null || number < 0) return null;
  if (number > 1 && number <= 100) return number / 100;
  return number <= 1 ? number : null;
};

const normalizeImpacts = (row: DatabaseRow): ContextImpact[] => {
  const value = pick(row, ['impacts', 'context_impacts', 'factor_impacts']);
  const impacts: ContextImpact[] = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const record = asRecord(entry);
      const key = asString(pick(record, ['key', 'factor', 'family']), `factor_${index + 1}`);
      const amount = asNumber(pick(record, ['value', 'impact', 'delta']));
      if (amount === null) return;
      impacts.push({
        key,
        label: asString(pick(record, ['label', 'name']), IMPACT_LABELS[key] ?? key),
        value: Math.abs(amount) > 1 && Math.abs(amount) <= 100 ? amount / 100 : amount,
      });
    });
  } else {
    const record = asRecord(value);
    if (record) {
      Object.entries(record).forEach(([key, rawAmount]) => {
        const amount = asNumber(rawAmount);
        if (amount === null) return;
        impacts.push({
          key,
          label: IMPACT_LABELS[key] ?? key,
          value: Math.abs(amount) > 1 && Math.abs(amount) <= 100 ? amount / 100 : amount,
        });
      });
    }
  }

  const legacyColumns: Array<[string, string[]]> = [
    ['objectives', ['objectives_impact', 'objective_impact']],
    ['rest', ['rest_impact', 'fatigue_impact']],
    ['availability', ['availability_impact', 'injuries_impact']],
    ['lineup', ['lineup_impact']],
  ];

  legacyColumns.forEach(([key, keys]) => {
    if (impacts.some((impact) => impact.key === key)) return;
    const amount = asNumber(pick(row, keys));
    if (amount === null) return;
    impacts.push({ key, label: IMPACT_LABELS[key], value: amount });
  });

  return impacts;
};

const safeUrl = (value: unknown): string | null => {
  const source = asString(value);
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const rowsFrom = (value: unknown): DatabaseRow[] => (
  Array.isArray(value) ? value.filter((entry): entry is DatabaseRow => Boolean(asRecord(entry))) : []
);

type ReadTableOptions = {
  limit?: number;
  orderBy?: string;
  ascending?: boolean;
  filters?: Array<{ column: string; value: string }>;
};

const readTable = async (table: string, options: ReadTableOptions = {}) => {
  const limit = options.limit ?? 5000;
  const pageSize = Math.min(500, limit);
  const rows: DatabaseRow[] = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    let query = supabase
      .from(table)
      .select('*')
      .order(options.orderBy ?? 'id', { ascending: options.ascending ?? false })
      .range(offset, Math.min(offset + pageSize - 1, limit - 1));
    for (const filter of options.filters ?? []) query = query.eq(filter.column, filter.value);
    const { data, error } = await query;
    if (error) return { rows, errorMessage: error.message };
    const page = rowsFrom(data);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, errorMessage: null };
};

const readRowsByValues = async (
  table: string,
  column: string,
  values: string[],
  orderBy = 'id',
) => {
  const unique = [...new Set(values.filter(Boolean))];
  const rows: DatabaseRow[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const { data, error } = await supabase.from(table).select('*')
      .in(column, batch).order(orderBy, { ascending: false });
    if (error) return { rows, errorMessage: error.message };
    rows.push(...rowsFrom(data));
  }
  return { rows, errorMessage: null };
};

const readLatestPredictionRows = async (fixtureId?: string) => {
  let query = supabase
    .from('prediction_snapshot_details')
    .select('*')
    .order('data_cutoff', { ascending: false });
  query = fixtureId
    ? query.eq('fixture_id', fixtureId)
    : query.in('fixture_status', ['scheduled', 'postponed']).gt('kickoff_at', new Date().toISOString());
  const { data, error } = await query.limit(fixtureId ? 100 : 1000);
  return { rows: rowsFrom(data), errorMessage: error?.message ?? null };
};

const mapById = (rows: DatabaseRow[]): Map<string, DatabaseRow> => new Map(
  rows
    .map((row): readonly [string, DatabaseRow] => [asString(row.id), row])
    .filter(([id]) => id !== ''),
);

const rowName = (row: DatabaseRow | undefined, fallback: string) => (
  asString(pick(row, ['name', 'display_name', 'short_name', 'code']), fallback)
);

const getFixtureLabel = (
  fixture: DatabaseRow | undefined,
  teamsById: Map<string, DatabaseRow>,
) => {
  if (!fixture) return 'Partido sin identificar';
  const home = rowName(
    teamsById.get(asString(pick(fixture, ['home_team_id', 'local_team_id']))),
    asString(pick(fixture, ['home_team_name', 'home_name']), 'Local'),
  );
  const away = rowName(
    teamsById.get(asString(pick(fixture, ['away_team_id', 'visitor_team_id']))),
    asString(pick(fixture, ['away_team_name', 'away_name']), 'Visitante'),
  );
  return `${home} vs ${away}`;
};

const decisionPriority = (decision: string) => {
  if (decision === 'paper_candidate') return 3;
  if (decision === 'no_bet') return 2;
  return 1;
};

const qualityLabel = (value: unknown) => {
  const record = asRecord(value);
  if (record) return asString(pick(record, ['status', 'label', 'coverage']), 'unknown');
  return asString(value, 'unknown');
};

const recommendationFromRow = (row: DatabaseRow | undefined): RecommendationSummary | null => {
  if (!row) return null;
  if (asString(row.status) !== 'available') return null;
  const expiresAt = asString(row.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;
  const id = asString(row.id);
  if (!id) return null;
  return {
    id,
    market: asString(row.market, 'Mercado'),
    outcome: asString(row.outcome),
    selection: asString(row.selection, 'Selección'),
    offeredOdds: asNumber(row.offered_odds),
    fairOdds: asNumber(row.fair_odds),
    edge: asNumber(pick(row, ['lower_bound_edge', 'edge'])),
    status: asString(row.status, 'available'),
  };
};

const marketTraceLabel = (row: DatabaseRow) => {
  const market = asString(row.market);
  const outcome = asString(row.outcome);
  return ({
    '1x2:home': 'Victoria local',
    '1x2:draw': 'Empate',
    '1x2:away': 'Victoria visitante',
    'over_under_2_5:over': 'Over 2.5',
    'over_under_2_5:under': 'Under 2.5',
    'btts:yes': 'Ambos marcan',
    'btts:no': 'No ambos marcan',
  } as Record<string, string>)[`${market}:${outcome}`] ?? `${market}: ${outcome}`;
};

const pricingFromRow = (row: DatabaseRow): PredictionPricing => ({
  offeredOdds: asNumber(row.offered_odds),
  fairOdds: asNumber(row.fair_odds),
  edge: asNumber(row.edge),
  conservativeEdge: asNumber(row.lower_bound_edge),
  probabilityEvPositive: normalizeProbability(row.probability_positive_ev),
});

const topScoresFromRow = (row: DatabaseRow): ScoreProbability[] => {
  const distribution = asRecord(row.score_distribution);
  return rowsFrom(distribution?.top).map((score) => ({
    home: asNumber(score.home) ?? 0,
    away: asNumber(score.away) ?? 0,
    probability: normalizeProbability(score.probability) ?? 0,
  })).filter((score) => score.probability > 0).slice(0, 5);
};

const stringValues = (value: unknown): Record<string, string> => {
  const source = asRecord(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

const competitiveContextFromRow = (row: DatabaseRow): CompetitiveContext | null => {
  const features = asRecord(row.context_features);
  const objectives = asRecord(features?.objective_states);
  const schedule = asRecord(features?.schedule);
  if (!objectives && !schedule) return null;
  return {
    homeObjectives: stringValues(objectives?.home),
    awayObjectives: stringValues(objectives?.away),
    homeObjectivesAsOf: asString(objectives?.home_as_of) || null,
    awayObjectivesAsOf: asString(objectives?.away_as_of) || null,
    homeRestDays: asNumber(schedule?.home_rest_days),
    awayRestDays: asNumber(schedule?.away_rest_days),
    homeMatchesLast14Days: asNumber(schedule?.home_matches_last_14_days),
    awayMatchesLast14Days: asNumber(schedule?.away_matches_last_14_days),
  };
};

const setOutcomeProbability = (
  target: ProbabilitySet,
  market: string,
  outcome: string,
  probability: number | null,
) => {
  if (market === '1x2' && outcome === 'home') target.home = probability;
  if (market === '1x2' && outcome === 'draw') target.draw = probability;
  if (market === '1x2' && outcome === 'away') target.away = probability;
  if (market === 'over_under_2_5' && outcome === 'over') target.over25 = probability;
  if (market === 'over_under_2_5' && outcome === 'under') target.under25 = probability;
  if (market === 'btts' && outcome === 'yes') target.bttsYes = probability;
};

const setOutcomeInterval = (
  target: ProbabilityIntervalSet,
  market: string,
  outcome: string,
  interval: ProbabilityInterval | null,
) => {
  if (market === '1x2' && outcome === 'home') target.home = interval;
  if (market === '1x2' && outcome === 'draw') target.draw = interval;
  if (market === '1x2' && outcome === 'away') target.away = interval;
  if (market === 'over_under_2_5' && outcome === 'over') target.over25 = interval;
  if (market === 'over_under_2_5' && outcome === 'under') target.under25 = interval;
  if (market === 'btts' && outcome === 'yes') target.bttsYes = interval;
};

export const loadPredictions = async (fixtureId?: string): Promise<PredictionDataResult> => {
  const predictionResult = await readLatestPredictionRows(fixtureId);
  const recommendationResult = await readRowsByValues(
    'recommendations',
    'prediction_snapshot_id',
    predictionResult.rows.map((row) => asString(row.id)),
    'created_at',
  );

  const warnings = [
    predictionResult.errorMessage && `Predicciones: ${predictionResult.errorMessage}`,
    recommendationResult.errorMessage && `Recomendaciones: ${recommendationResult.errorMessage}`,
  ].filter((message): message is string => Boolean(message));

  const recommendationsBySnapshot = new Map<string, DatabaseRow>();
  recommendationResult.rows.filter((row) => asString(row.status) === 'available').forEach((row) => {
    const snapshotId = asString(row.prediction_snapshot_id);
    if (snapshotId) recommendationsBySnapshot.set(snapshotId, row);
  });

  const grouped = new Map<string, PredictionListItem>();
  const rowsByGroup = new Map<string, DatabaseRow[]>();
  predictionResult.rows.forEach((row) => {
    const rowId = asString(row.id);
    const fixtureId = asString(row.fixture_id);
    const modelId = asString(row.model_version_id);
    const horizon = asString(row.horizon, 'informational');
    const cutoffAt = asString(row.data_cutoff) || null;
    if (!rowId || !fixtureId) return;

    const groupKey = [fixtureId, modelId, horizon, cutoffAt ?? ''].join(':');
    let item = grouped.get(groupKey);
    if (!item) {
      item = {
        id: rowId,
        fixtureId,
        competitionCode: asString(row.competition_code, 'OTRA'),
        competitionName: asString(row.competition_name, 'Competición'),
        homeTeam: asString(row.home_team_name, 'Local'),
        awayTeam: asString(row.away_team_name, 'Visitante'),
        homeTeamId: asString(row.home_team_id),
        awayTeamId: asString(row.away_team_id),
        kickoffAt: asString(row.kickoff_at) || null,
        stage: asString(row.stage) || null,
        fixtureStatus: asString(row.fixture_status, 'scheduled'),
        horizon,
        cutoffAt,
        modelVersion: asString(row.model_version, 'sin versión'),
        lambdaHome: asNumber(row.lambda_home),
        lambdaAway: asNumber(row.lambda_away),
        base: { ...EMPTY_PROBABILITIES },
        contextual: { ...EMPTY_PROBABILITIES },
        intervals: { ...EMPTY_INTERVALS },
        impacts: [],
        traceLabel: '',
        pricing: pricingFromRow(row),
        decision: asString(row.decision, 'informational'),
        dataQuality: qualityLabel(row.data_quality),
        sourceFreshness: asString(asRecord(row.data_quality)?.source_freshness, 'unknown'),
        oddsObservedAt: asString(row.odds_observed_at) || null,
        recommendation: null,
        topScores: topScoresFromRow(row),
        qualification: asRecord(row.qualification_probabilities),
        competitiveContext: competitiveContextFromRow(row),
        reasons: [],
        evidenceIds: Array.isArray(row.context_evidence_ids)
          ? row.context_evidence_ids.filter((id): id is string => typeof id === 'string')
          : [],
        lineups: [],
        availability: [],
        rawPrediction: row,
        rawFixture: {
          id: fixtureId,
          kickoff_at: row.kickoff_at,
          status: row.fixture_status,
          stage: row.stage,
        },
      };
      grouped.set(groupKey, item);
      rowsByGroup.set(groupKey, []);
    }
    rowsByGroup.get(groupKey)?.push(row);

    const market = asString(row.market);
    const outcome = asString(row.outcome);
    setOutcomeProbability(item.base, market, outcome, normalizeProbability(row.probability_base));
    setOutcomeProbability(item.contextual, market, outcome, normalizeProbability(row.probability_contextual));

    const intervalLow = normalizeProbability(row.interval_low);
    const intervalHigh = normalizeProbability(row.interval_high);
    const interval = intervalLow !== null && intervalHigh !== null
      ? { low: intervalLow, high: intervalHigh }
      : null;
    setOutcomeInterval(item.intervals, market, outcome, interval);

    const rowDecision = asString(row.decision, 'informational');
    if (decisionPriority(rowDecision) > decisionPriority(item.decision)) item.decision = rowDecision;
    const recommendation = recommendationFromRow(recommendationsBySnapshot.get(rowId));
    if (recommendation) item.recommendation = recommendation;
  });

  const normalized = [...grouped.entries()].map(([groupKey, item]) => {
    if (item.base.over25 !== null && item.base.under25 === null) item.base.under25 = 1 - item.base.over25;
    if (item.contextual.over25 !== null && item.contextual.under25 === null) item.contextual.under25 = 1 - item.contextual.over25;
    const traceRows = rowsByGroup.get(groupKey) ?? [];
    const focusRow = traceRows.find((row) => recommendationsBySnapshot.has(asString(row.id)))
      ?? [...traceRows].sort((left, right) => {
        const priority = decisionPriority(asString(right.decision)) - decisionPriority(asString(left.decision));
        if (priority !== 0) return priority;
        const order = ['1x2:home', '1x2:draw', '1x2:away', 'over_under_2_5:over', 'over_under_2_5:under', 'btts:yes', 'btts:no'];
        const leftKey = `${asString(left.market)}:${asString(left.outcome)}`;
        const rightKey = `${asString(right.market)}:${asString(right.outcome)}`;
        return order.indexOf(leftKey) - order.indexOf(rightKey);
      })[0];
    if (focusRow) {
      item.impacts = normalizeImpacts(focusRow);
      item.traceLabel = marketTraceLabel(focusRow);
      item.pricing = pricingFromRow(focusRow);
      item.dataQuality = qualityLabel(focusRow.data_quality);
      item.sourceFreshness = asString(asRecord(focusRow.data_quality)?.source_freshness, 'unknown');
      item.oddsObservedAt = asString(focusRow.odds_observed_at) || null;
      item.reasons = Array.isArray(focusRow.reasons)
        ? focusRow.reasons.filter((reason): reason is string => typeof reason === 'string')
        : [];
      item.rawPrediction = focusRow;
    }
    const preMatch = ['scheduled', 'postponed'].includes(item.fixtureStatus)
      && Boolean(item.kickoffAt && Date.parse(item.kickoffAt) > Date.now());
    if (!preMatch) item.recommendation = null;
    if (item.decision === 'paper_candidate' && !item.recommendation) {
      item.decision = 'no_bet';
      if (!item.reasons.includes('recommendation_expired_or_unavailable')) {
        item.reasons.push('recommendation_expired_or_unavailable');
      }
    }
    return item;
  });

  normalized.sort((left, right) => {
    const leftTime = Date.parse(left.cutoffAt ?? left.kickoffAt ?? '') || 0;
    const rightTime = Date.parse(right.cutoffAt ?? right.kickoffAt ?? '') || 0;
    return rightTime - leftTime;
  });

  const latestByFixture = new Map<string, PredictionListItem>();
  normalized.forEach((item) => {
    if (!latestByFixture.has(item.fixtureId)) latestByFixture.set(item.fixtureId, item);
  });

  return { predictions: [...latestByFixture.values()], warnings };
};

const loadFixtureSquadContext = async (fixtureId: string, prediction: PredictionListItem) => {
  const [lineupResponse, availabilityResponse] = await Promise.all([
    supabase.from('lineups').select('*').eq('fixture_id', fixtureId)
      .order('observed_at', { ascending: false }).limit(100),
    supabase.from('player_availability_snapshots').select('*').eq('fixture_id', fixtureId)
      .order('as_of', { ascending: false }).limit(1000),
  ]);
  const warnings = [
    lineupResponse.error && `Alineaciones: ${lineupResponse.error.message}`,
    availabilityResponse.error && `Disponibilidad: ${availabilityResponse.error.message}`,
  ].filter((message): message is string => Boolean(message));
  const latestLineups = new Map<string, DatabaseRow>();
  for (const row of rowsFrom(lineupResponse.data)) {
    const key = `${asString(row.team_id)}:${asString(row.lineup_type)}`;
    if (!latestLineups.has(key)) latestLineups.set(key, row);
  }
  const lineupIds = [...latestLineups.values()].map((row) => asString(row.id)).filter(Boolean);
  const playerResult = lineupIds.length
    ? await readRowsByValues('lineup_players', 'lineup_id', lineupIds, 'created_at')
    : { rows: [], errorMessage: null };
  if (playerResult.errorMessage) warnings.push(`Jugadores del XI: ${playerResult.errorMessage}`);
  const startersByLineup = new Map<string, string[]>();
  for (const row of playerResult.rows) {
    if (!asBoolean(row.is_starter)) continue;
    const lineupId = asString(row.lineup_id);
    const players = startersByLineup.get(lineupId) ?? [];
    players.push(asString(row.player_name, 'Jugador sin identificar'));
    startersByLineup.set(lineupId, players);
  }
  const teamName = (teamId: string) => (
    teamId === prediction.homeTeamId ? prediction.homeTeam
      : teamId === prediction.awayTeamId ? prediction.awayTeam
        : 'Equipo sin identificar'
  );
  const lineups: LineupSummary[] = [...latestLineups.values()].map((row) => ({
    id: asString(row.id),
    teamId: asString(row.team_id),
    teamName: teamName(asString(row.team_id)),
    type: asString(row.lineup_type, 'scenario'),
    formation: asString(row.formation) || null,
    sourceTier: asString(row.source_tier, 'unknown'),
    observedAt: asString(row.observed_at) || null,
    starters: startersByLineup.get(asString(row.id)) ?? [],
  }));
  const latestAvailability = new Map<string, DatabaseRow>();
  for (const row of rowsFrom(availabilityResponse.data)) {
    const key = `${asString(row.team_id)}:${asString(row.player_external_ref)}`;
    if (!latestAvailability.has(key)) latestAvailability.set(key, row);
  }
  const availability: AvailabilitySummary[] = [...latestAvailability.values()].map((row) => ({
    id: asString(row.id),
    teamId: asString(row.team_id),
    teamName: teamName(asString(row.team_id)),
    playerName: asString(row.player_name, 'Jugador sin identificar'),
    status: asString(row.status, 'unknown'),
    probabilityAvailable: normalizeProbability(row.probability_available),
    asOf: asString(row.as_of) || null,
  }));
  return { lineups, availability, warnings };
};

export const loadPredictionDetail = async (fixtureId: string): Promise<PredictionDataResult> => {
  const result = await loadPredictions(fixtureId);
  const prediction = result.predictions.find((item) => item.fixtureId === fixtureId);
  if (prediction) {
    const squad = await loadFixtureSquadContext(fixtureId, prediction);
    prediction.lineups = squad.lineups;
    prediction.availability = squad.availability;
    result.warnings.push(...squad.warnings);
  }
  return {
    predictions: prediction ? [prediction] : [],
    warnings: result.warnings,
  };
};

export const loadContextObservations = async (fixtureId?: string): Promise<ContextDataResult> => {
  const observationResult = await readTable('context_observations', {
    limit: 10000,
    orderBy: 'fetched_at',
    filters: fixtureId ? [{ column: 'fixture_id', value: fixtureId }] : [],
  });
  const observationIds = observationResult.rows.map((row) => asString(row.id));
  const fixtureIds = observationResult.rows.map((row) => asString(row.fixture_id));
  const [reviewResult, fixtureResult] = await Promise.all([
    readRowsByValues('context_reviews', 'observation_id', observationIds, 'reviewed_at'),
    readRowsByValues('fixtures', 'id', fixtureIds, 'kickoff_at'),
  ]);
  const teamIds = [
    ...observationResult.rows.map((row) => asString(row.team_id)),
    ...fixtureResult.rows.flatMap((row) => [asString(row.home_team_id), asString(row.away_team_id)]),
  ];
  const teamResult = await readRowsByValues('teams', 'id', teamIds, 'updated_at');

  const warnings = [
    observationResult.errorMessage && `Contexto: ${observationResult.errorMessage}`,
    reviewResult.errorMessage && `Revisiones: ${reviewResult.errorMessage}`,
    fixtureResult.errorMessage && `Partidos: ${fixtureResult.errorMessage}`,
    teamResult.errorMessage && `Equipos: ${teamResult.errorMessage}`,
  ].filter((message): message is string => Boolean(message));

  const fixturesById = mapById(fixtureResult.rows);
  const teamsById = mapById(teamResult.rows);
  const correctionsByObservation = new Map<string, DatabaseRow>();
  reviewResult.rows
    .filter((row) => asString(row.decision) === 'corrected')
    .sort((left, right) => Date.parse(asString(right.reviewed_at)) - Date.parse(asString(left.reviewed_at)))
    .forEach((row) => {
      const observationId = asString(row.observation_id);
      if (observationId && !correctionsByObservation.has(observationId)) correctionsByObservation.set(observationId, row);
    });
  const observations = observationResult.rows.map((row): ContextObservationItem | null => {
    const id = asString(row.id);
    if (!id) return null;
    const fixtureId = asString(pick(row, ['fixture_id', 'match_id'])) || null;
    const fixture = fixtureId ? fixturesById.get(fixtureId) : undefined;
    const teamId = asString(row.team_id);

    return {
      id,
      fixtureId,
      fixtureLabel: getFixtureLabel(fixture, teamsById),
      affectedEntity: teamId ? rowName(teamsById.get(teamId), 'Equipo sin identificar') : 'Partido completo',
      type: asString(pick(row, ['observation_type', 'type', 'signal_type']), 'contexto'),
      summary: asString(
        correctionsByObservation.get(id)?.corrected_summary
          ?? pick(row, ['summary', 'evidence_summary', 'paraphrase', 'content']),
        'Sin resumen disponible',
      ),
      authority: asString(pick(row, ['authority', 'source_tier', 'tier']), 'unknown'),
      confidence: normalizeProbability(pick(row, ['confidence', 'certainty'])),
      sourceUrl: safeUrl(pick(row, ['source_url', 'url'])),
      reviewStatus: asString(pick(row, ['review_status', 'status']), 'pending'),
      publishedAt: asString(pick(row, ['published_at', 'observed_at'])) || null,
      fetchedAt: asString(pick(row, ['fetched_at', 'ingested_at', 'created_at'])) || null,
      isConflicted: asBoolean(pick(row, ['is_conflicted', 'conflicted', 'has_conflict'])),
    };
  }).filter((item): item is ContextObservationItem => item !== null);

  observations.sort((left, right) => (
    (Date.parse(right.fetchedAt ?? right.publishedAt ?? '') || 0)
      - (Date.parse(left.fetchedAt ?? left.publishedAt ?? '') || 0)
  ));

  return { observations, warnings };
};

export const requestFixtureRefresh = async (fixtureId: string, idempotencyKey: string) => {
  const { data, error } = await supabase.functions.invoke('refresh-fixture', {
    body: {
      fixture_id: fixtureId,
      idempotency_key: idempotencyKey,
    },
  });
  if (error) throw error;
  if (data?.status === 'failed' || data?.request?.status === 'failed') {
    throw new Error('La actualización idempotente anterior terminó con error.');
  }
  return data;
};

export const requestFootballSync = async (input: {
  competitionCode?: string;
  date?: string;
}, idempotencyKey: string) => {
  const scope = input.date ? 'date' : input.competitionCode ? 'competition' : 'all';
  const { data, error } = await supabase.functions.invoke('sync-football', {
    body: {
      scope,
      competition_code: input.competitionCode,
      date: input.date,
      priority: 9,
      idempotency_key: idempotencyKey,
    },
  });
  if (error) throw error;
  if (data?.status === 'failed' || data?.request?.status === 'failed') {
    throw new Error('La sincronización idempotente anterior terminó con error.');
  }
  return data;
};

export const submitContextReview = async (
  observationId: string,
  decision: 'approved' | 'corrected' | 'rejected',
  correctedSummary?: string,
  idempotencyKey?: string,
) => {
  const { data, error } = await supabase.functions.invoke('review-context', {
    body: {
      observation_id: observationId,
      decision,
      corrected_summary: correctedSummary || undefined,
      idempotency_key: idempotencyKey ?? crypto.randomUUID(),
    },
  });
  if (error) throw error;
  return data;
};

export const extractContextObservation = async (
  fixtureId: string,
  sourceUrl: string,
  teamId?: string,
) => {
  const { data, error } = await supabase.functions.invoke('extract-context', {
    body: {
      fixture_id: fixtureId,
      source_url: sourceUrl,
      team_id: teamId || undefined,
    },
  });
  if (error) throw error;
  return data;
};

export const registerPaperRecommendation = async (
  recommendationId: string,
  betInput: ManualBetInput,
  idempotencyKey = crypto.randomUUID(),
) => {
  const { data, error } = await supabase.functions.invoke('register-recommendation', {
    body: {
      recommendation_id: recommendationId,
      bet_input: betInput,
      idempotency_key: idempotencyKey,
    },
  });
  if (error) throw error;
  return data;
};
