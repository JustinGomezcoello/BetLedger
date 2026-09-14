import type { ScoreDistribution, ScoreModelParameters } from './types.ts'

const DEFAULT_TAIL_TOLERANCE = 1e-10
const HARD_GOAL_CUTOFF = 200

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`)
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

export function poissonProbabilities(lambda: number, maxGoals: number): readonly number[] {
  assertFiniteNonNegative(lambda, 'lambda')
  assertPositiveInteger(maxGoals, 'maxGoals')

  const probabilities = new Array<number>(maxGoals + 1).fill(0)
  probabilities[0] = Math.exp(-lambda)

  for (let goals = 1; goals <= maxGoals; goals += 1) {
    probabilities[goals] = probabilities[goals - 1] * (lambda / goals)
  }

  return probabilities
}

export function minimumGoalCutoff(
  lambda: number,
  tailTolerance = DEFAULT_TAIL_TOLERANCE,
): number {
  assertFiniteNonNegative(lambda, 'lambda')
  if (!Number.isFinite(tailTolerance) || tailTolerance <= 0 || tailTolerance >= 1) {
    throw new RangeError('tailTolerance must be between zero and one')
  }

  let probability = Math.exp(-lambda)
  let cumulative = probability
  let goals = 0

  while (1 - cumulative > tailTolerance && goals < HARD_GOAL_CUTOFF) {
    goals += 1
    probability *= lambda / goals
    cumulative += probability
  }

  if (goals === HARD_GOAL_CUTOFF && 1 - cumulative > tailTolerance) {
    throw new RangeError('lambda is too large for the supported score grid')
  }

  return Math.max(1, goals)
}

function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  homeExpectedGoals: number,
  awayExpectedGoals: number,
  rho: number,
): number {
  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - homeExpectedGoals * awayExpectedGoals * rho
  }
  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + homeExpectedGoals * rho
  }
  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + awayExpectedGoals * rho
  }
  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho
  }
  return 1
}

export interface ScoreDistributionOptions {
  readonly maxGoals?: number
  readonly tailTolerance?: number
}

export function buildScoreDistribution(
  parameters: ScoreModelParameters,
  options: ScoreDistributionOptions = {},
): ScoreDistribution {
  const { homeExpectedGoals, awayExpectedGoals, rho = 0 } = parameters
  assertFiniteNonNegative(homeExpectedGoals, 'homeExpectedGoals')
  assertFiniteNonNegative(awayExpectedGoals, 'awayExpectedGoals')
  if (!Number.isFinite(rho)) {
    throw new RangeError('rho must be finite')
  }

  const maxGoals = options.maxGoals ?? Math.max(
    minimumGoalCutoff(homeExpectedGoals, options.tailTolerance),
    minimumGoalCutoff(awayExpectedGoals, options.tailTolerance),
  )
  assertPositiveInteger(maxGoals, 'maxGoals')

  const home = poissonProbabilities(homeExpectedGoals, maxGoals)
  const away = poissonProbabilities(awayExpectedGoals, maxGoals)
  const probabilities: number[][] = []
  let total = 0

  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    const row: number[] = []
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const tau = dixonColesTau(
        homeGoals,
        awayGoals,
        homeExpectedGoals,
        awayExpectedGoals,
        rho,
      )
      if (tau < 0) {
        throw new RangeError('rho produces a negative low-score probability')
      }
      const probability = home[homeGoals] * away[awayGoals] * tau
      row.push(probability)
      total += probability
    }
    probabilities.push(row)
  }

  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError('score distribution has no finite probability mass')
  }

  return {
    maxGoals,
    probabilities: probabilities.map((row) => row.map((value) => value / total)),
  }
}

export function probabilityOfScore(
  distribution: ScoreDistribution,
  homeGoals: number,
  awayGoals: number,
): number {
  if (
    !Number.isInteger(homeGoals)
    || !Number.isInteger(awayGoals)
    || homeGoals < 0
    || awayGoals < 0
  ) {
    return 0
  }
  return distribution.probabilities[homeGoals]?.[awayGoals] ?? 0
}
