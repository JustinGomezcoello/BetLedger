export type ObjectiveState = 'secured' | 'alive' | 'eliminated' | 'conditional_external' | 'unknown';

export type ObjectiveStanding = {
  teamId: string;
  position: number;
  played: number;
  points: number;
};

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
);

const numberArray = (value: unknown) => (
  Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isInteger(item) && item > 0)
    : []
);

export const calculateObjectiveStates = (
  rows: readonly ObjectiveStanding[],
  row: ObjectiveStanding,
  ruleVersion: { rules?: unknown; verification_status?: string } | null,
): {
  title: ObjectiveState;
  european_places: ObjectiveState;
  survival: ObjectiveState;
  uefa_knockout?: ObjectiveState;
  uefa_round_of_16?: ObjectiveState;
  note: string;
} => {
  if (ruleVersion?.verification_status !== 'official_verified') {
    return {
      title: 'unknown',
      european_places: 'unknown',
      survival: 'unknown',
      note: 'Reglas provisionales: no se publican conclusiones matemáticas.',
    };
  }
  const rules = record(ruleVersion.rules);
  const leaguePhase = record(rules.league_phase);
  const leaguePhaseDirect = numberArray(leaguePhase.direct_round_of_16);
  const leaguePhasePlayoff = numberArray(leaguePhase.knockout_playoff);
  const isUefaLeaguePhase = leaguePhaseDirect.length > 0 && leaguePhasePlayoff.length > 0;
  const matchesPerClub = Number(isUefaLeaguePhase
    ? leaguePhase.matches_per_club
    : rules.matches_per_club);
  const expectedClubs = Number(isUefaLeaguePhase ? leaguePhase.clubs : rules.clubs);
  if (!Number.isInteger(matchesPerClub) || matchesPerClub < 1 || rows.length < 2
      || (Number.isInteger(expectedClubs) && expectedClubs > 1 && rows.length !== expectedClubs)) {
    return {
      title: 'unknown',
      european_places: 'unknown',
      survival: 'unknown',
      ...(isUefaLeaguePhase ? {
        uefa_knockout: 'unknown' as const,
        uefa_round_of_16: 'unknown' as const,
      } : {}),
      note: 'No hay una regla oficial completa para calcular objetivos.',
    };
  }

  const otherRows = rows.filter((candidate) => candidate.teamId !== row.teamId);
  const maximumPoints = (candidate: ObjectiveStanding) => (
    candidate.points + 3 * Math.max(0, matchesPerClub - candidate.played)
  );
  const leaderPoints = Math.max(...rows.map((candidate) => candidate.points));
  const ownMaximum = maximumPoints(row);
  const title: ObjectiveState = isUefaLeaguePhase
    ? 'unknown'
    : row.played >= matchesPerClub
      ? (row.position === 1 ? 'secured' : 'eliminated')
      : row.points > Math.max(...otherRows.map(maximumPoints))
        ? 'secured'
        : ownMaximum < leaderPoints ? 'eliminated' : 'alive';

  if (isUefaLeaguePhase) {
    const stateForTop = (places: number): ObjectiveState => {
      if (row.played >= matchesPerClub) return row.position <= places ? 'secured' : 'eliminated';
      const guaranteedBelow = otherRows.filter((candidate) => maximumPoints(candidate) < row.points).length;
      const guaranteedAbove = otherRows.filter((candidate) => candidate.points > ownMaximum).length;
      if (guaranteedBelow >= rows.length - places) return 'secured';
      if (guaranteedAbove >= places) return 'eliminated';
      return 'alive';
    };
    const directPlaces = Math.max(...leaguePhaseDirect);
    const playoffPlaces = Math.max(...leaguePhasePlayoff);
    const directState = stateForTop(directPlaces);
    const knockoutState = stateForTop(playoffPlaces);
    const roundOf16State: ObjectiveState = directState === 'secured'
      ? 'secured'
      : knockoutState === 'eliminated'
        ? 'eliminated'
        : row.played >= matchesPerClub && row.position <= playoffPlaces
          ? 'conditional_external'
          : 'alive';
    return {
      title: 'unknown',
      european_places: 'unknown',
      survival: 'unknown',
      uefa_knockout: knockoutState,
      uefa_round_of_16: roundOf16State,
      note: 'Se separa el acceso al playoff/fase eliminatoria de la clasificación a octavos.',
    };
  }

  const relegation = record(rules.relegation);
  const direct = numberArray(relegation.direct);
  const playoff = numberArray(relegation.playoff);
  let survival: ObjectiveState = 'unknown';
  if (direct.length || playoff.length) {
    if (row.played >= matchesPerClub) {
      survival = direct.includes(row.position)
        ? 'eliminated'
        : playoff.includes(row.position) ? 'conditional_external' : 'secured';
    } else {
      const unsafePlaces = direct.length + playoff.length;
      const guaranteedBelow = otherRows.filter((candidate) => maximumPoints(candidate) < row.points).length;
      const guaranteedAbove = otherRows.filter((candidate) => candidate.points > ownMaximum).length;
      survival = guaranteedBelow >= unsafePlaces
        ? 'secured'
        : guaranteedAbove >= rows.length - direct.length ? 'eliminated' : 'alive';
    }
  }

  return {
    title,
    // Domestic cups and association coefficients can change UEFA allocation;
    // this field deliberately remains conditional until those inputs exist.
    european_places: 'conditional_external',
    survival,
    note: 'Cada objetivo se calcula por separado; nunca se etiqueta un equipo como sin nada que jugar.',
  };
};
