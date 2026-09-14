import { describe, expect, it } from 'vitest'
import { inferDixonColesEloRates } from '../../../supabase/functions/_shared/inference-contract.ts'
import golden from '../../../tests/golden/inference_contract_v1.json'

describe('football-probability-v1 inference contract', () => {
  it('matches the Python Dixon-Coles + Elo lambda formula', () => {
    const rates = inferDixonColesEloRates(
      golden.parameters,
      golden.competition_code,
      golden.home_team_id,
      golden.away_team_id,
    )

    expect(rates).not.toBeNull()
    expect(rates?.home).toBeCloseTo(golden.expected.lambda_home, 12)
    expect(rates?.away).toBeCloseTo(golden.expected.lambda_away, 12)
    expect(rates?.rho).toBe(golden.expected.rho)
  })

  it('fails closed for an unknown contract version', () => {
    expect(inferDixonColesEloRates({}, 'PL', 'home', 'away')).toBeNull()
  })

  it('uses the global club rating for a team new to a UEFA competition', () => {
    const rates = inferDixonColesEloRates({
      inference_contract_version: 'football-probability-v1',
      intercept_log: 0,
      home_advantage_log: 0,
      elo_coefficient: 1,
      elo_home_advantage: 0,
      rho: -0.04,
      team_ratings: {
        promoted_home: { elo: 1700, attack: 0, defense_weakness: 0 },
        promoted_away: { elo: 1300, attack: 0, defense_weakness: 0 },
      },
      competition_models: {
        UCL: {
          intercept_log: 0,
          home_advantage_log: 0,
          elo_coefficient: 1,
          elo_home_advantage: 0,
          rho: -0.04,
          team_ratings: {},
        },
      },
    }, 'UCL', 'promoted_home', 'promoted_away')

    expect(rates?.home).toBeCloseTo(Math.exp(1), 12)
    expect(rates?.away).toBeCloseTo(Math.exp(-1), 12)
    expect(rates?.rho).toBe(-0.04)
  })

  it('uses the same supported lambda range as Python and the score grid', () => {
    const rates = inferDixonColesEloRates({
      inference_contract_version: 'football-probability-v1',
      intercept_log: 0,
      home_advantage_log: 0,
      elo_coefficient: 0,
      rho: 0,
      team_ratings: {
        home: { attack: 20 },
        away: { attack: -20 },
      },
    }, 'PL', 'home', 'away')

    expect(rates?.home).toBe(5)
    expect(rates?.away).toBe(0.15)
  })
})
