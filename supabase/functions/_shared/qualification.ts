export type QualificationProbability = {
  home: number;
  away: number;
  decidedInExtraTimeOrPenalties: number;
};

const poisson = (lambda: number, maxGoals: number) => {
  const probabilities = new Array<number>(maxGoals + 1).fill(0);
  probabilities[0] = Math.exp(-lambda);
  for (let goal = 1; goal <= maxGoals; goal += 1) {
    probabilities[goal] = probabilities[goal - 1] * lambda / goal;
  }
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  return probabilities.map((value) => value / total);
};

export const calculateSecondLegQualification = (
  regulationGrid: readonly (readonly number[])[],
  lambdaHome: number,
  lambdaAway: number,
  aggregateHomeBefore: number,
  aggregateAwayBefore: number,
): QualificationProbability => {
  if (aggregateHomeBefore < 0 || aggregateAwayBefore < 0) {
    throw new Error('aggregate scores must be non-negative');
  }
  const extraHome = poisson(Math.max(0.01, lambdaHome / 3), 7);
  const extraAway = poisson(Math.max(0.01, lambdaAway / 3), 7);
  let home = 0;
  let away = 0;
  let extraTimeOrPenalties = 0;
  for (let homeGoals = 0; homeGoals < regulationGrid.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < regulationGrid[homeGoals].length; awayGoals += 1) {
      const regulationProbability = regulationGrid[homeGoals][awayGoals];
      const homeAggregate = aggregateHomeBefore + homeGoals;
      const awayAggregate = aggregateAwayBefore + awayGoals;
      if (homeAggregate > awayAggregate) {
        home += regulationProbability;
        continue;
      }
      if (awayAggregate > homeAggregate) {
        away += regulationProbability;
        continue;
      }
      extraTimeOrPenalties += regulationProbability;
      for (let extraHomeGoals = 0; extraHomeGoals < extraHome.length; extraHomeGoals += 1) {
        for (let extraAwayGoals = 0; extraAwayGoals < extraAway.length; extraAwayGoals += 1) {
          const extraProbability = regulationProbability
            * extraHome[extraHomeGoals]
            * extraAway[extraAwayGoals];
          if (extraHomeGoals > extraAwayGoals) home += extraProbability;
          else if (extraAwayGoals > extraHomeGoals) away += extraProbability;
          else {
            // Penalty ability is not inferred from unrelated match results.
            home += extraProbability / 2;
            away += extraProbability / 2;
          }
        }
      }
    }
  }
  const total = home + away;
  return {
    home: home / total,
    away: away / total,
    decidedInExtraTimeOrPenalties: extraTimeOrPenalties,
  };
};
