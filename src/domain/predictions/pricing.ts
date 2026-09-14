function assertProbability(probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('probability must be between zero and one')
  }
}

function assertDecimalOdds(decimalOdds: number): void {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    throw new RangeError('decimalOdds must be greater than one')
  }
}

export function fairDecimalOdds(probability: number): number | null {
  assertProbability(probability)
  return probability === 0 ? null : 1 / probability
}

export function expectedValue(probability: number, decimalOdds: number): number {
  assertProbability(probability)
  assertDecimalOdds(decimalOdds)
  return probability * decimalOdds - 1
}

export function removeOverround(decimalOdds: readonly number[]): readonly number[] {
  if (decimalOdds.length < 2) {
    throw new RangeError('at least two prices are required to remove overround')
  }
  const implied = decimalOdds.map((price) => {
    assertDecimalOdds(price)
    return 1 / price
  })
  const total = implied.reduce((sum, probability) => sum + probability, 0)
  return implied.map((probability) => probability / total)
}
