export type RatePerturbation = {
  id: string;
  weight: number;
  homeMultiplier: number;
  awayMultiplier: number;
};

const halton = (index: number, base: number) => {
  let value = 0;
  let fraction = 1 / base;
  let remaining = index;
  while (remaining > 0) {
    value += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
    fraction /= base;
  }
  return value;
};

export const deterministicRatePerturbations = (
  logRateStandardDeviation: number,
  sampleCount = 81,
): RatePerturbation[] => {
  if (!Number.isFinite(logRateStandardDeviation) || logRateStandardDeviation <= 0) {
    throw new RangeError('log-rate standard deviation must be positive');
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 5 || sampleCount % 2 === 0) {
    throw new RangeError('sample count must be an odd integer of at least five');
  }

  const samples: Array<{ id: string; home: number; away: number }> = [
    { id: 'qmc-central', home: 1, away: 1 },
  ];
  const pairs = (sampleCount - 1) / 2;
  for (let index = 1; index <= pairs; index += 1) {
    const radialUniform = Math.max(halton(index, 2), 1e-12);
    const angularUniform = halton(index, 3);
    const radius = Math.sqrt(-2 * Math.log(radialUniform));
    const zTotal = radius * Math.cos(2 * Math.PI * angularUniform);
    const zBalance = radius * Math.sin(2 * Math.PI * angularUniform);
    const homeZ = Math.max(-3, Math.min(3, (zTotal + zBalance) / Math.SQRT2));
    const awayZ = Math.max(-3, Math.min(3, (zTotal - zBalance) / Math.SQRT2));
    samples.push(
      {
        id: `qmc-${index}-positive`,
        home: Math.exp(logRateStandardDeviation * homeZ),
        away: Math.exp(logRateStandardDeviation * awayZ),
      },
      {
        id: `qmc-${index}-negative`,
        home: Math.exp(-logRateStandardDeviation * homeZ),
        away: Math.exp(-logRateStandardDeviation * awayZ),
      },
    );
  }

  const meanHome = samples.reduce((sum, sample) => sum + sample.home, 0) / samples.length;
  const meanAway = samples.reduce((sum, sample) => sum + sample.away, 0) / samples.length;
  return samples.map((sample) => ({
    id: sample.id,
    weight: 1 / samples.length,
    homeMultiplier: sample.home / meanHome,
    awayMultiplier: sample.away / meanAway,
  }));
};
