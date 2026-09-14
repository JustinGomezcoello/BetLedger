import { expectedValue, fairDecimalOdds } from './pricing.ts'
import type {
  PaperCandidateDecision,
  PredictionHorizon,
  PredictionSnapshot,
  SelectionProbabilityEstimate,
} from './types.ts'

export interface PredictionSnapshotInput {
  readonly fixtureId: string
  readonly horizon: PredictionHorizon
  readonly estimate: SelectionProbabilityEstimate
  readonly offeredOdds: number | null
  readonly modelVersionId: string
  readonly dataCutoff: string
  readonly candidateDecision: PaperCandidateDecision
}

export function createPredictionSnapshot(input: PredictionSnapshotInput): PredictionSnapshot {
  const {
    fixtureId,
    horizon,
    estimate,
    offeredOdds,
    modelVersionId,
    dataCutoff,
    candidateDecision,
  } = input
  if (fixtureId.trim() === '') throw new TypeError('fixtureId cannot be empty')
  if (modelVersionId.trim() === '') throw new TypeError('modelVersionId cannot be empty')
  if (!Number.isFinite(Date.parse(dataCutoff))) {
    throw new TypeError('dataCutoff must be a valid ISO timestamp')
  }

  return {
    fixtureId,
    market: estimate.selection.market,
    outcome: estimate.selection.outcome,
    horizon,
    probabilityBase: estimate.baseProbability,
    probabilityContextual: estimate.contextualProbability,
    intervalLow: estimate.interval90.low,
    intervalHigh: estimate.interval90.high,
    fairOdds: fairDecimalOdds(estimate.contextualProbability),
    offeredOdds,
    edge: offeredOdds === null
      ? null
      : expectedValue(estimate.contextualProbability, offeredOdds),
    impacts: estimate.impacts,
    modelVersionId,
    dataCutoff,
    decision: candidateDecision.decision,
    reasons: candidateDecision.reasons,
  }
}
