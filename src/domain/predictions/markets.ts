import type {
  ExactScoreProbability,
  ExpectedGoals,
  MarketProbabilities,
  MarketSelection,
  ScoreDistribution,
} from './types.ts'

export function calculateExpectedGoals(distribution: ScoreDistribution): ExpectedGoals {
  let home = 0
  let away = 0
  for (let homeGoals = 0; homeGoals <= distribution.maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= distribution.maxGoals; awayGoals += 1) {
      const probability = distribution.probabilities[homeGoals]?.[awayGoals] ?? 0
      home += homeGoals * probability
      away += awayGoals * probability
    }
  }
  return { home, away, total: home + away }
}

export function mostLikelyScores(
  distribution: ScoreDistribution,
  limit = 5,
): readonly ExactScoreProbability[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer')
  }
  const scores: ExactScoreProbability[] = []
  for (let homeGoals = 0; homeGoals <= distribution.maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= distribution.maxGoals; awayGoals += 1) {
      scores.push({
        homeGoals,
        awayGoals,
        probability: distribution.probabilities[homeGoals]?.[awayGoals] ?? 0,
      })
    }
  }
  return scores
    .sort((left, right) => (
      right.probability - left.probability
      || left.homeGoals + left.awayGoals - (right.homeGoals + right.awayGoals)
      || left.homeGoals - right.homeGoals
    ))
    .slice(0, limit)
}

export function calculateMarketProbabilities(
  distribution: ScoreDistribution,
): MarketProbabilities {
  let home = 0
  let draw = 0
  let away = 0
  let under = 0
  let bothTeamsScore = 0

  for (let homeGoals = 0; homeGoals <= distribution.maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= distribution.maxGoals; awayGoals += 1) {
      const probability = distribution.probabilities[homeGoals]?.[awayGoals] ?? 0
      if (homeGoals > awayGoals) home += probability
      else if (homeGoals === awayGoals) draw += probability
      else away += probability

      if (homeGoals + awayGoals <= 2) under += probability
      if (homeGoals > 0 && awayGoals > 0) bothTeamsScore += probability
    }
  }

  return {
    oneXTwo: { home, draw, away },
    overUnder25: { over: 1 - under, under },
    bothTeamsToScore: { yes: bothTeamsScore, no: 1 - bothTeamsScore },
  }
}

export function probabilityForSelection(
  markets: MarketProbabilities,
  selection: MarketSelection,
): number {
  if (selection.market === '1x2') {
    return markets.oneXTwo[selection.outcome]
  }
  return markets.overUnder25[selection.outcome]
}

export function selectionKey(selection: MarketSelection): string {
  return `${selection.market}:${selection.outcome}`
}
