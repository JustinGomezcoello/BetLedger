export const PREDICTION_MARKETS = ['1x2', 'over_under_2_5'] as const

export type PredictionMarket = (typeof PREDICTION_MARKETS)[number]

export type OneXTwoOutcome = 'home' | 'draw' | 'away'
export type OverUnderOutcome = 'over' | 'under'
export type PredictionOutcome = OneXTwoOutcome | OverUnderOutcome

export type MarketSelection =
  | { readonly market: '1x2'; readonly outcome: OneXTwoOutcome }
  | { readonly market: 'over_under_2_5'; readonly outcome: OverUnderOutcome }

export const MARKET_SELECTIONS: readonly MarketSelection[] = [
  { market: '1x2', outcome: 'home' },
  { market: '1x2', outcome: 'draw' },
  { market: '1x2', outcome: 'away' },
  { market: 'over_under_2_5', outcome: 'over' },
  { market: 'over_under_2_5', outcome: 'under' },
]

export type PredictionHorizon = 't24h' | 't6h' | 'official_lineup'
export type PredictionDecision = 'paper_candidate' | 'no_bet' | 'informational'

export type ContextFactor = 'objectives' | 'rest' | 'availability' | 'lineup'

export const CONTEXT_FACTORS: readonly ContextFactor[] = [
  'objectives',
  'rest',
  'availability',
  'lineup',
]

export interface ScoreModelParameters {
  readonly homeExpectedGoals: number
  readonly awayExpectedGoals: number
  /** Dixon-Coles low-score correlation. Use zero for independent Poisson. */
  readonly rho?: number
}

export interface ScoreDistribution {
  readonly maxGoals: number
  /** Matrix indexed as probabilities[homeGoals][awayGoals]. */
  readonly probabilities: readonly (readonly number[])[]
}

export interface OneXTwoProbabilities {
  readonly home: number
  readonly draw: number
  readonly away: number
}

export interface OverUnderProbabilities {
  readonly over: number
  readonly under: number
}

export interface BothTeamsToScoreProbabilities {
  readonly yes: number
  readonly no: number
}

export interface ExpectedGoals {
  readonly home: number
  readonly away: number
  readonly total: number
}

export interface ExactScoreProbability {
  readonly homeGoals: number
  readonly awayGoals: number
  readonly probability: number
}

export interface MarketProbabilities {
  readonly oneXTwo: OneXTwoProbabilities
  readonly overUnder25: OverUnderProbabilities
  readonly bothTeamsToScore: BothTeamsToScoreProbabilities
}

export interface GoalRateAdjustment {
  readonly factor: ContextFactor
  /** Additive adjustment on log(lambda_home). */
  readonly homeLogRateDelta: number
  /** Additive adjustment on log(lambda_away). */
  readonly awayLogRateDelta: number
  /** Evidence identifiers must belong to only one factor inside a scenario. */
  readonly evidenceIds?: readonly string[]
}

export interface ContextScenario {
  readonly id: string
  readonly weight: number
  readonly adjustments: readonly GoalRateAdjustment[]
}

export interface ScenarioSelectionProbability {
  readonly scenarioId: string
  readonly weight: number
  readonly probability: number
}

export interface ProbabilityInterval90 {
  readonly low: number
  readonly high: number
}

export interface GroupedProbabilityImpact {
  readonly factor: ContextFactor
  /** Contextual probability minus the probability with this group removed. */
  readonly deltaPercentagePoints: number
  readonly method: 'leave_one_group_out'
}

export interface SelectionProbabilityEstimate {
  readonly selection: MarketSelection
  readonly baseProbability: number
  readonly contextualProbability: number
  /** Scenario-weighted interval; model uncertainty must enter as scenarios. */
  readonly interval90: ProbabilityInterval90
  readonly impacts: readonly GroupedProbabilityImpact[]
  readonly scenarioProbabilities: readonly ScenarioSelectionProbability[]
}

export interface ContextualPrediction {
  readonly baseDistribution: ScoreDistribution
  readonly contextualDistribution: ScoreDistribution
  readonly baseExpectedGoals: ExpectedGoals
  readonly contextualExpectedGoals: ExpectedGoals
  readonly baseMarkets: MarketProbabilities
  readonly contextualMarkets: MarketProbabilities
  readonly estimates: readonly SelectionProbabilityEstimate[]
}

export type DecisionReason =
  | 'candidate_thresholds_met'
  | 'insufficient_data'
  | 'official_lineup_missing'
  | 'offered_odds_missing'
  | 'stale_odds'
  | 'material_conflict'
  | 'edge_below_threshold'
  | 'ev_confidence_below_threshold'
  | 'not_best_candidate_for_fixture'

export interface PaperCandidateDecision {
  readonly decision: PredictionDecision
  readonly reasons: readonly DecisionReason[]
  readonly conservativeProbability: number | null
  readonly conservativeEdge: number | null
  readonly probabilityEvPositive: number | null
  readonly oddsAgeMinutes: number | null
}

export interface PredictionSnapshot {
  readonly fixtureId: string
  readonly market: PredictionMarket
  readonly outcome: PredictionOutcome
  readonly horizon: PredictionHorizon
  readonly probabilityBase: number
  readonly probabilityContextual: number
  readonly intervalLow: number
  readonly intervalHigh: number
  readonly fairOdds: number | null
  readonly offeredOdds: number | null
  readonly edge: number | null
  readonly impacts: readonly GroupedProbabilityImpact[]
  readonly modelVersionId: string
  readonly dataCutoff: string
  readonly decision: PredictionDecision
  readonly reasons: readonly DecisionReason[]
}
