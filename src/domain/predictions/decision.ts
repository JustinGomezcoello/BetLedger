import { expectedValue } from './pricing.ts'
import type {
  DecisionReason,
  PaperCandidateDecision,
  ScenarioSelectionProbability,
} from './types.ts'

function parseTimestamp(value: string, name: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid ISO timestamp`)
  return timestamp
}

function weightedQuantile(
  samples: readonly ScenarioSelectionProbability[],
  quantile: number,
): number {
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0)
  const sorted = [...samples].sort((left, right) => left.probability - right.probability)
  let cumulative = 0
  for (const sample of sorted) {
    cumulative += sample.weight / totalWeight
    if (cumulative + Number.EPSILON >= quantile) return sample.probability
  }
  return sorted[sorted.length - 1].probability
}

function validateSamples(samples: readonly ScenarioSelectionProbability[]): void {
  if (samples.length === 0) throw new RangeError('at least one probability sample is required')
  for (const sample of samples) {
    if (!Number.isFinite(sample.weight) || sample.weight <= 0) {
      throw new RangeError('sample weights must be finite and greater than zero')
    }
    if (
      !Number.isFinite(sample.probability)
      || sample.probability < 0
      || sample.probability > 1
    ) {
      throw new RangeError('sample probabilities must be between zero and one')
    }
  }
}

export interface PaperCandidateInput {
  readonly offeredOdds: number | null
  readonly oddsObservedAt: string | null
  readonly evaluatedAt: string
  readonly hasOfficialLineup: boolean
  readonly hasMaterialConflict: boolean
  readonly dataSufficient: boolean
  readonly probabilitySamples: readonly ScenarioSelectionProbability[]
  readonly maxOddsAgeMinutes?: number
  readonly minimumConservativeEdge?: number
  readonly minimumProbabilityEvPositive?: number
}

export function evaluatePaperCandidate(input: PaperCandidateInput): PaperCandidateDecision {
  const {
    offeredOdds,
    oddsObservedAt,
    evaluatedAt,
    hasOfficialLineup,
    hasMaterialConflict,
    dataSufficient,
    probabilitySamples,
    maxOddsAgeMinutes = 30,
    minimumConservativeEdge = 0.02,
    minimumProbabilityEvPositive = 0.9,
  } = input

  if (!Number.isFinite(maxOddsAgeMinutes) || maxOddsAgeMinutes < 0) {
    throw new RangeError('maxOddsAgeMinutes must be finite and non-negative')
  }
  if (!Number.isFinite(minimumConservativeEdge)) {
    throw new RangeError('minimumConservativeEdge must be finite')
  }
  if (
    !Number.isFinite(minimumProbabilityEvPositive)
    || minimumProbabilityEvPositive < 0
    || minimumProbabilityEvPositive > 1
  ) {
    throw new RangeError('minimumProbabilityEvPositive must be between zero and one')
  }

  const gateReasons: DecisionReason[] = []
  if (!dataSufficient) gateReasons.push('insufficient_data')
  if (!hasOfficialLineup) gateReasons.push('official_lineup_missing')
  if (hasMaterialConflict) gateReasons.push('material_conflict')
  if (offeredOdds === null || oddsObservedAt === null) gateReasons.push('offered_odds_missing')

  if (gateReasons.length > 0 || offeredOdds === null || oddsObservedAt === null) {
    return {
      decision: 'informational',
      reasons: gateReasons,
      conservativeProbability: null,
      conservativeEdge: null,
      probabilityEvPositive: null,
      oddsAgeMinutes: null,
    }
  }

  validateSamples(probabilitySamples)
  const evaluatedAtMs = parseTimestamp(evaluatedAt, 'evaluatedAt')
  const oddsObservedAtMs = parseTimestamp(oddsObservedAt, 'oddsObservedAt')
  const oddsAgeMinutes = (evaluatedAtMs - oddsObservedAtMs) / 60_000
  if (oddsAgeMinutes < 0) throw new RangeError('oddsObservedAt cannot be after evaluatedAt')
  if (oddsAgeMinutes > maxOddsAgeMinutes) {
    return {
      decision: 'informational',
      reasons: ['stale_odds'],
      conservativeProbability: null,
      conservativeEdge: null,
      probabilityEvPositive: null,
      oddsAgeMinutes,
    }
  }

  const conservativeProbability = weightedQuantile(probabilitySamples, 0.1)
  const conservativeEdge = expectedValue(conservativeProbability, offeredOdds)
  const totalWeight = probabilitySamples.reduce((sum, sample) => sum + sample.weight, 0)
  const positiveWeight = probabilitySamples.reduce(
    (sum, sample) => sum + (expectedValue(sample.probability, offeredOdds) > 0 ? sample.weight : 0),
    0,
  )
  const probabilityEvPositive = positiveWeight / totalWeight
  const reasons: DecisionReason[] = []
  if (conservativeEdge < minimumConservativeEdge) reasons.push('edge_below_threshold')
  if (probabilityEvPositive < minimumProbabilityEvPositive) {
    reasons.push('ev_confidence_below_threshold')
  }

  return {
    decision: reasons.length === 0 ? 'paper_candidate' : 'no_bet',
    reasons: reasons.length === 0 ? ['candidate_thresholds_met'] : reasons,
    conservativeProbability,
    conservativeEdge,
    probabilityEvPositive,
    oddsAgeMinutes,
  }
}

export interface IdentifiedDecision {
  readonly id: string
  readonly result: PaperCandidateDecision
}

export function keepBestCandidate(
  decisions: readonly IdentifiedDecision[],
): readonly IdentifiedDecision[] {
  const eligible = decisions
    .filter(({ result }) => result.decision === 'paper_candidate')
    .sort((left, right) => (
      (right.result.conservativeEdge ?? Number.NEGATIVE_INFINITY)
      - (left.result.conservativeEdge ?? Number.NEGATIVE_INFINITY)
    ))
  const winnerId = eligible[0]?.id

  return decisions.map((decision) => {
    if (decision.result.decision !== 'paper_candidate' || decision.id === winnerId) {
      return decision
    }
    return {
      id: decision.id,
      result: {
        ...decision.result,
        decision: 'no_bet',
        reasons: ['not_best_candidate_for_fixture'],
      },
    }
  })
}
