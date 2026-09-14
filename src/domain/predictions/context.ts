import {
  calculateExpectedGoals,
  calculateMarketProbabilities,
  probabilityForSelection,
} from './markets.ts'
import {
  buildScoreDistribution,
  minimumGoalCutoff,
  type ScoreDistributionOptions,
} from './scoreDistribution.ts'
import {
  CONTEXT_FACTORS,
  MARKET_SELECTIONS,
  type ContextFactor,
  type ContextScenario,
  type ContextualPrediction,
  type GoalRateAdjustment,
  type MarketProbabilities,
  type MarketSelection,
  type ScoreDistribution,
  type ScoreModelParameters,
  type SelectionProbabilityEstimate,
} from './types.ts'

interface PreparedScenario {
  readonly id: string
  readonly weight: number
  readonly parameters: ScoreModelParameters
  readonly adjustments: readonly GoalRateAdjustment[]
}

function validateScenario(scenario: ContextScenario): void {
  if (scenario.id.trim() === '') throw new TypeError('scenario id cannot be empty')
  if (!Number.isFinite(scenario.weight) || scenario.weight <= 0) {
    throw new RangeError('scenario weight must be finite and greater than zero')
  }

  const evidenceOwners = new Map<string, ContextFactor>()
  for (const adjustment of scenario.adjustments) {
    if (
      !Number.isFinite(adjustment.homeLogRateDelta)
      || !Number.isFinite(adjustment.awayLogRateDelta)
    ) {
      throw new RangeError('goal-rate adjustments must be finite')
    }
    for (const evidenceId of adjustment.evidenceIds ?? []) {
      const normalizedId = evidenceId.trim()
      if (normalizedId === '') throw new TypeError('evidence id cannot be empty')
      const owner = evidenceOwners.get(normalizedId)
      if (owner !== undefined && owner !== adjustment.factor) {
        throw new TypeError(
          `evidence ${normalizedId} is assigned to both ${owner} and ${adjustment.factor}`,
        )
      }
      evidenceOwners.set(normalizedId, adjustment.factor)
    }
  }
}

function prepareScenarios(
  base: ScoreModelParameters,
  scenarios: readonly ContextScenario[],
  excludedFactor?: ContextFactor,
): readonly PreparedScenario[] {
  if (scenarios.length === 0) throw new RangeError('at least one context scenario is required')
  scenarios.forEach(validateScenario)
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) {
    throw new TypeError('scenario ids must be unique')
  }

  const totalWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0)
  return scenarios.map((scenario) => {
    const activeAdjustments = scenario.adjustments.filter(
      (adjustment) => adjustment.factor !== excludedFactor,
    )
    const homeDelta = activeAdjustments.reduce(
      (sum, adjustment) => sum + adjustment.homeLogRateDelta,
      0,
    )
    const awayDelta = activeAdjustments.reduce(
      (sum, adjustment) => sum + adjustment.awayLogRateDelta,
      0,
    )
    const homeExpectedGoals = base.homeExpectedGoals * Math.exp(homeDelta)
    const awayExpectedGoals = base.awayExpectedGoals * Math.exp(awayDelta)
    if (!Number.isFinite(homeExpectedGoals) || !Number.isFinite(awayExpectedGoals)) {
      throw new RangeError('context adjustments produce non-finite expected goals')
    }
    return {
      id: scenario.id,
      weight: scenario.weight / totalWeight,
      parameters: { homeExpectedGoals, awayExpectedGoals, rho: base.rho },
      adjustments: activeAdjustments,
    }
  })
}

function resolveMaxGoals(
  base: ScoreModelParameters,
  scenarios: readonly PreparedScenario[],
  options: ScoreDistributionOptions,
): number {
  if (options.maxGoals !== undefined) return options.maxGoals
  const lambdas = [
    base.homeExpectedGoals,
    base.awayExpectedGoals,
    ...scenarios.flatMap((scenario) => [
      scenario.parameters.homeExpectedGoals,
      scenario.parameters.awayExpectedGoals,
    ]),
  ]
  return Math.max(
    ...lambdas.map((lambda) => minimumGoalCutoff(lambda, options.tailTolerance)),
  )
}

function mixDistributions(
  scenarios: readonly PreparedScenario[],
  maxGoals: number,
): ScoreDistribution {
  const probabilities = Array.from(
    { length: maxGoals + 1 },
    () => new Array<number>(maxGoals + 1).fill(0),
  )

  for (const scenario of scenarios) {
    const distribution = buildScoreDistribution(scenario.parameters, { maxGoals })
    for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
      for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
        probabilities[homeGoals][awayGoals] += (
          distribution.probabilities[homeGoals]?.[awayGoals] ?? 0
        ) * scenario.weight
      }
    }
  }

  return { maxGoals, probabilities }
}

function weightedQuantile(
  values: readonly { readonly value: number; readonly weight: number }[],
  quantile: number,
): number {
  if (values.length === 0) throw new RangeError('weighted quantile needs at least one value')
  if (quantile < 0 || quantile > 1) throw new RangeError('quantile must be between zero and one')

  const sorted = [...values].sort((left, right) => left.value - right.value)
  let cumulative = 0
  for (const item of sorted) {
    cumulative += item.weight
    if (cumulative + Number.EPSILON >= quantile) return item.value
  }
  return sorted[sorted.length - 1].value
}

function marketsByScenario(
  scenarios: readonly PreparedScenario[],
  maxGoals: number,
): readonly { readonly id: string; readonly weight: number; readonly markets: MarketProbabilities }[] {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    weight: scenario.weight,
    markets: calculateMarketProbabilities(
      buildScoreDistribution(scenario.parameters, { maxGoals }),
    ),
  }))
}

function calculateFactorImpacts(
  base: ScoreModelParameters,
  scenarios: readonly ContextScenario[],
  maxGoals: number,
  contextualMarkets: MarketProbabilities,
  selection: MarketSelection,
): SelectionProbabilityEstimate['impacts'] {
  return CONTEXT_FACTORS.map((factor) => {
    const withoutFactor = prepareScenarios(base, scenarios, factor)
    const withoutDistribution = mixDistributions(withoutFactor, maxGoals)
    const withoutProbability = probabilityForSelection(
      calculateMarketProbabilities(withoutDistribution),
      selection,
    )
    return {
      factor,
      deltaPercentagePoints: (
        probabilityForSelection(contextualMarkets, selection) - withoutProbability
      ) * 100,
      method: 'leave_one_group_out' as const,
    }
  })
}

export type ContextualPredictionOptions = ScoreDistributionOptions

export function buildContextualPrediction(
  base: ScoreModelParameters,
  scenarios: readonly ContextScenario[],
  options: ContextualPredictionOptions = {},
): ContextualPrediction {
  const prepared = prepareScenarios(base, scenarios)
  const maxGoals = resolveMaxGoals(base, prepared, options)
  const baseDistribution = buildScoreDistribution(base, { maxGoals })
  const contextualDistribution = mixDistributions(prepared, maxGoals)
  const baseMarkets = calculateMarketProbabilities(baseDistribution)
  const contextualMarkets = calculateMarketProbabilities(contextualDistribution)
  const scenarioMarkets = marketsByScenario(prepared, maxGoals)

  const estimates = MARKET_SELECTIONS.map((selection) => {
    const scenarioProbabilities = scenarioMarkets.map((scenario) => ({
      scenarioId: scenario.id,
      weight: scenario.weight,
      probability: probabilityForSelection(scenario.markets, selection),
    }))
    const quantileValues = scenarioProbabilities.map(({ probability, weight }) => ({
      value: probability,
      weight,
    }))
    return {
      selection,
      baseProbability: probabilityForSelection(baseMarkets, selection),
      contextualProbability: probabilityForSelection(contextualMarkets, selection),
      interval90: {
        low: weightedQuantile(quantileValues, 0.05),
        high: weightedQuantile(quantileValues, 0.95),
      },
      impacts: calculateFactorImpacts(
        base,
        scenarios,
        maxGoals,
        contextualMarkets,
        selection,
      ),
      scenarioProbabilities,
    }
  })

  return {
    baseDistribution,
    contextualDistribution,
    baseExpectedGoals: calculateExpectedGoals(baseDistribution),
    contextualExpectedGoals: calculateExpectedGoals(contextualDistribution),
    baseMarkets,
    contextualMarkets,
    estimates,
  }
}

export function findSelectionEstimate(
  prediction: ContextualPrediction,
  selection: MarketSelection,
): SelectionProbabilityEstimate {
  const estimate = prediction.estimates.find(
    (candidate) => candidate.selection.market === selection.market
      && candidate.selection.outcome === selection.outcome,
  )
  if (estimate === undefined) throw new Error('selection estimate is missing')
  return estimate
}
