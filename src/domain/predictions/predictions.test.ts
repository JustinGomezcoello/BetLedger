import { expect, test } from 'vitest'
import { buildContextualPrediction, findSelectionEstimate } from './context.ts'
import { evaluatePaperCandidate, keepBestCandidate } from './decision.ts'
import {
  calculateExpectedGoals,
  calculateMarketProbabilities,
  mostLikelyScores,
} from './markets.ts'
import { expectedValue, fairDecimalOdds, removeOverround } from './pricing.ts'
import { buildScoreDistribution } from './scoreDistribution.ts'
import { calculateObjectiveStates } from '../../../supabase/functions/_shared/objectives.ts'
import { calculateSecondLegQualification } from '../../../supabase/functions/_shared/qualification.ts'
import { extractContextFact } from '../../../supabase/functions/_shared/source-extraction.ts'
import {
  predictionGenerationHash,
  predictionInputHash,
} from '../../../supabase/functions/_shared/prediction-identity.ts'
import { deterministicRatePerturbations } from '../../../supabase/functions/_shared/uncertainty.ts'

test('golden Excel case produces the actual Over 2.5 probability', () => {
  const distribution = buildScoreDistribution({
    homeExpectedGoals: 1.981355932,
    awayExpectedGoals: 1.229885057,
  })
  const markets = calculateMarketProbabilities(distribution)

  expect(Math.abs(markets.overUnder25.over - 0.622437)).toBeLessThan(0.000001)
  expect(Math.abs(markets.oneXTwo.home - 0.5483)).toBeLessThan(0.0001)
  expect(Math.abs(markets.oneXTwo.draw - 0.2173)).toBeLessThan(0.0001)
  expect(Math.abs(markets.oneXTwo.away - 0.2344)).toBeLessThan(0.0001)
  const expectedGoals = calculateExpectedGoals(distribution)
  expect(Math.abs(expectedGoals.total - 3.211240989)).toBeLessThan(0.000001)
  expect(mostLikelyScores(distribution, 3)).toHaveLength(3)
})

test('Dixon-Coles distribution is normalized', () => {
  const distribution = buildScoreDistribution({
    homeExpectedGoals: 1.4,
    awayExpectedGoals: 1.1,
    rho: -0.08,
  })
  const total = distribution.probabilities
    .flat()
    .reduce((sum, probability) => sum + probability, 0)
  expect(Math.abs(total - 1)).toBeLessThan(1e-12)

  const markets = calculateMarketProbabilities(distribution)
  expect(Math.abs(
    markets.oneXTwo.home + markets.oneXTwo.draw + markets.oneXTwo.away - 1,
  )).toBeLessThan(1e-12)
})

test('context is mixed at score-distribution level and exposes grouped impacts', () => {
  const result = buildContextualPrediction(
    { homeExpectedGoals: 1.5, awayExpectedGoals: 1.0, rho: -0.05 },
    [
      {
        id: 'strong-home-lineup',
        weight: 3,
        adjustments: [{
          factor: 'lineup',
          homeLogRateDelta: 0.1,
          awayLogRateDelta: 0,
          evidenceIds: ['official-xi-home'],
        }],
      },
      {
        id: 'neutral-home-lineup',
        weight: 1,
        adjustments: [{
          factor: 'lineup',
          homeLogRateDelta: 0,
          awayLogRateDelta: 0,
          evidenceIds: ['official-xi-away'],
        }],
      },
    ],
  )
  const home = findSelectionEstimate(result, { market: '1x2', outcome: 'home' })
  const weightedPoint = home.scenarioProbabilities.reduce(
    (sum, scenario) => sum + scenario.weight * scenario.probability,
    0,
  )

  expect(Math.abs(home.contextualProbability - weightedPoint)).toBeLessThan(1e-12)
  expect(home.interval90.low).toBeLessThanOrEqual(home.contextualProbability)
  expect(home.interval90.high).toBeGreaterThanOrEqual(home.contextualProbability)
  expect(
    (home.impacts.find((impact) => impact.factor === 'lineup')?.deltaPercentagePoints ?? 0) > 0,
  ).toBe(true)
})

test('the same evidence cannot be counted in two context families', () => {
  expect(() => buildContextualPrediction(
    { homeExpectedGoals: 1.5, awayExpectedGoals: 1 },
    [{
      id: 'invalid',
      weight: 1,
      adjustments: [
        {
          factor: 'availability',
          homeLogRateDelta: -0.1,
          awayLogRateDelta: 0,
          evidenceIds: ['player-7-status'],
        },
        {
          factor: 'lineup',
          homeLogRateDelta: -0.1,
          awayLogRateDelta: 0,
          evidenceIds: ['player-7-status'],
        },
      ],
    }],
  )).toThrow(/assigned to both/)
})

test('paper candidate gates use p10, EV confidence, fresh odds, and official XI', () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({
    scenarioId: `sample-${index}`,
    weight: 1,
    probability: 0.56 + index * 0.002,
  }))
  const result = evaluatePaperCandidate({
    offeredOdds: 2,
    oddsObservedAt: '2026-09-09T17:45:00.000Z',
    evaluatedAt: '2026-09-09T18:00:00.000Z',
    hasOfficialLineup: true,
    hasMaterialConflict: false,
    dataSufficient: true,
    probabilitySamples: samples,
  })

  expect(result.decision).toBe('paper_candidate')
  expect(result.conservativeEdge ?? 0).toBeGreaterThanOrEqual(0.02)
  expect(result.probabilityEvPositive).toBe(1)

  const blocked = evaluatePaperCandidate({
    offeredOdds: 2,
    oddsObservedAt: '2026-09-09T17:45:00.000Z',
    evaluatedAt: '2026-09-09T18:00:00.000Z',
    hasOfficialLineup: false,
    hasMaterialConflict: false,
    dataSufficient: true,
    probabilitySamples: samples,
  })
  expect(blocked.decision).toBe('informational')
  expect(blocked.reasons).toEqual(['official_lineup_missing'])
})

test('only the candidate with the largest conservative edge survives per fixture', () => {
  const decisions = keepBestCandidate([
    {
      id: 'home',
      result: {
        decision: 'paper_candidate',
        reasons: ['candidate_thresholds_met'],
        conservativeProbability: 0.55,
        conservativeEdge: 0.1,
        probabilityEvPositive: 0.95,
        oddsAgeMinutes: 4,
      },
    },
    {
      id: 'over',
      result: {
        decision: 'paper_candidate',
        reasons: ['candidate_thresholds_met'],
        conservativeProbability: 0.6,
        conservativeEdge: 0.2,
        probabilityEvPositive: 0.95,
        oddsAgeMinutes: 5,
      },
    },
  ])

  expect(decisions.find(({ id }) => id === 'over')?.result.decision).toBe('paper_candidate')
  expect(
    decisions.find(({ id }) => id === 'home')?.result.reasons,
  ).toEqual(['not_best_candidate_for_fixture'])
})

test('pricing functions expose fair odds, EV, and proportional no-vig prices', () => {
  expect(fairDecimalOdds(0.5)).toBe(2)
  expect(Math.abs(expectedValue(0.55, 2) - 0.1)).toBeLessThan(1e-12)
  const noVig = removeOverround([1.9, 1.9])
  expect(noVig).toEqual([0.5, 0.5])
})

test('objective rules fail closed until verified and keep playoff status conditional', () => {
  const rows = Array.from({ length: 18 }, (_, index) => ({
    teamId: `team-${index + 1}`,
    position: index + 1,
    played: 34,
    points: 70 - index * 3,
  }))
  const rules = {
    matches_per_club: 34,
    relegation: { playoff: [16], direct: [17, 18] },
  }

  expect(calculateObjectiveStates(rows, rows[0], {
    rules,
    verification_status: 'provisional',
  }).title).toBe('unknown')
  expect(calculateObjectiveStates(rows, rows[0], {
    rules,
    verification_status: 'official_verified',
  })).toMatchObject({ title: 'secured', survival: 'secured' })
  expect(calculateObjectiveStates(rows, rows[15], {
    rules,
    verification_status: 'official_verified',
  }).survival).toBe('conditional_external')
  expect(calculateObjectiveStates(rows, rows[17], {
    rules,
    verification_status: 'official_verified',
  }).survival).toBe('eliminated')
})

test('UEFA league-phase objectives separate knockout access from the round of 16', () => {
  const rows = Array.from({ length: 36 }, (_, index) => ({
    teamId: `uefa-team-${index + 1}`,
    position: index + 1,
    played: 8,
    points: 30 - index,
  }))
  const ruleVersion = {
    verification_status: 'official_verified',
    rules: {
      league_phase: {
        clubs: 36,
        matches_per_club: 8,
        direct_round_of_16: [1, 8],
        knockout_playoff: [9, 24],
        eliminated: [25, 36],
      },
    },
  }

  expect(calculateObjectiveStates(rows, rows[0], ruleVersion)).toMatchObject({
    uefa_knockout: 'secured',
    uefa_round_of_16: 'secured',
  })
  expect(calculateObjectiveStates(rows, rows[8], ruleVersion)).toMatchObject({
    uefa_knockout: 'secured',
    uefa_round_of_16: 'conditional_external',
  })
  expect(calculateObjectiveStates(rows, rows[24], ruleVersion)).toMatchObject({
    uefa_knockout: 'eliminated',
    uefa_round_of_16: 'eliminated',
  })
  expect(calculateObjectiveStates(rows.slice(0, 4), rows[0], ruleVersion)).toMatchObject({
    uefa_knockout: 'unknown',
    uefa_round_of_16: 'unknown',
  })
})

test('UEFA qualification remains separate from the 90-minute 1X2 market', () => {
  const regulation = buildScoreDistribution({
    homeExpectedGoals: 1.7,
    awayExpectedGoals: 1.0,
  })
  const qualification = calculateSecondLegQualification(
    regulation.probabilities,
    1.7,
    1.0,
    0,
    1,
  )
  const matchMarket = calculateMarketProbabilities(regulation)

  expect(qualification.home + qualification.away).toBeCloseTo(1, 12)
  expect(qualification.decidedInExtraTimeOrPenalties).toBeGreaterThan(0)
  expect(qualification.home).not.toBeCloseTo(matchMarket.oneXTwo.home, 4)
})

test('context extraction stores a factual paraphrase instead of article prose', () => {
  const articleSentence = 'El entrenador confirmó que el delantero sufrió una lesión muscular durante el entrenamiento.'
  const extracted = extractContextFact(`
    <html>
      <head><title>Parte médico oficial</title></head>
      <body><p>${articleSentence}</p></body>
    </html>
  `)

  expect(extracted.observationType).toBe('injury')
  expect(extracted.summary).toBe(
    'La fuente informa una lesión o duda física que puede afectar la disponibilidad.',
  )
  expect(extracted.summary).not.toContain(articleSentence)
  expect(extracted.fingerprintMaterial).toContain(articleSentence)
})

test('prediction identity is canonical, retry-safe, and preserves A-B-A transitions', async () => {
  const inputA = await predictionInputHash({ fixture: 'one', odds: { home: 2, away: 4 } })
  const reorderedA = await predictionInputHash({ odds: { away: 4, home: 2 }, fixture: 'one' })
  const inputB = await predictionInputHash({ fixture: 'one', odds: { home: 1.9, away: 4 } })
  expect(reorderedA).toBe(inputA)
  expect(inputB).not.toBe(inputA)

  const generation = (previousSnapshotAnchor: string, inputHash: string) => predictionGenerationHash({
    engineVersion: 'engine/v2',
    fixtureId: 'fixture-1',
    modelVersionId: 'model-1',
    horizon: 'official_lineup',
    previousSnapshotAnchor,
    inputHash,
  })
  const firstB = await generation('snapshot-a1', inputB)
  expect(await generation('snapshot-a1', inputB)).toBe(firstB)
  const secondA = await generation('snapshot-b1', inputA)
  const secondB = await generation('snapshot-a2', inputB)
  expect(secondA).not.toBe(await generation('genesis', inputA))
  expect(secondB).not.toBe(firstB)
})

test('QMC uncertainty samples are deterministic, normalized, and centered', () => {
  const samples = deterministicRatePerturbations(0.14)
  const repeated = deterministicRatePerturbations(0.14)
  const weightedMean = (field: 'homeMultiplier' | 'awayMultiplier') => samples.reduce(
    (sum, sample) => sum + sample.weight * sample[field],
    0,
  )

  expect(samples).toEqual(repeated)
  expect(samples).toHaveLength(81)
  expect(samples.reduce((sum, sample) => sum + sample.weight, 0)).toBeCloseTo(1, 12)
  expect(weightedMean('homeMultiplier')).toBeCloseTo(1, 12)
  expect(weightedMean('awayMultiplier')).toBeCloseTo(1, 12)
  expect(samples.some((sample) => sample.homeMultiplier < 1)).toBe(true)
  expect(samples.some((sample) => sample.homeMultiplier > 1)).toBe(true)
  expect(samples.some((sample) => sample.awayMultiplier < 1)).toBe(true)
  expect(samples.some((sample) => sample.awayMultiplier > 1)).toBe(true)
})
