export type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);

const numeric = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Keep this support identical to the Python reference and to the score-grid
// runtime. Rates outside it are not numerically reliable with a 0..10 grid.
const clippedExp = (value: number) => Math.min(
  5,
  Math.max(Math.exp(Math.min(3, Math.max(-3, value))), 0.15),
);

export type InferenceRates = {
  home: number;
  away: number;
  rho: number;
};

/** Exact consumer for the versioned football-probability-v1 Python artifact. */
export const inferDixonColesEloRates = (
  parameters: JsonRecord,
  competitionCode: string,
  homeTeamId: string,
  awayTeamId: string,
): InferenceRates | null => {
  if (parameters.inference_contract_version !== 'football-probability-v1') return null;
  const competition = record(record(parameters.competition_models)[competitionCode]);
  const source = Object.keys(competition).length ? competition : parameters;
  const competitionRatings = record(source.team_ratings);
  const globalRatings = record(parameters.team_ratings);
  const homeCompetitionRating = record(competitionRatings[homeTeamId]);
  const awayCompetitionRating = record(competitionRatings[awayTeamId]);
  // A club without history in the current UEFA competition inherits its
  // cross-competition rating instead of being treated as an average club.
  const home = Object.keys(homeCompetitionRating).length
    ? homeCompetitionRating
    : record(globalRatings[homeTeamId]);
  const away = Object.keys(awayCompetitionRating).length
    ? awayCompetitionRating
    : record(globalRatings[awayTeamId]);
  const homeElo = numeric(home.elo, 1500);
  const awayElo = numeric(away.elo, 1500);
  const eloHomeAdvantage = numeric(source.elo_home_advantage, numeric(parameters.elo_home_advantage, 55));
  const eloDifference = (homeElo + eloHomeAdvantage - awayElo) / 400;
  const intercept = numeric(source.intercept_log, numeric(parameters.intercept_log, 0));
  const homeAdvantage = numeric(source.home_advantage_log, numeric(parameters.home_advantage_log, 0));
  const eloCoefficient = numeric(source.elo_coefficient, numeric(parameters.elo_coefficient, 0));
  const homeEta = intercept
    + homeAdvantage
    + numeric(home.attack, 0)
    + numeric(away.defense_weakness, 0)
    + eloCoefficient * eloDifference;
  const awayEta = intercept
    + numeric(away.attack, 0)
    + numeric(home.defense_weakness, 0)
    - eloCoefficient * eloDifference;
  return {
    home: clippedExp(homeEta),
    away: clippedExp(awayEta),
    rho: Math.min(0.2, Math.max(-0.2, numeric(source.rho, numeric(parameters.rho, 0)))),
  };
};
