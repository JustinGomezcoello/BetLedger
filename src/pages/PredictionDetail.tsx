import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, BookOpenCheck, CalendarClock, ChevronRight, CircleAlert, Clock3, ExternalLink, Goal, Layers3, Link2, RefreshCw, Send, ShieldCheck, TrendingDown, TrendingUp, UserRoundCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { extractContextObservation, loadContextObservations, loadPredictionDetail, requestFixtureRefresh } from '../lib/prediction-data';
import type { AvailabilitySummary, ContextObservationItem, LineupSummary, PredictionListItem, ProbabilityInterval } from '../lib/prediction-data';

const probabilityText = (value: number | null, decimals = 1) => (
  value === null ? '—' : `${(value * 100).toFixed(decimals)}%`
);

const numericValue = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const dateTimeText = (value: string | null) => {
  if (!value) return 'No disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No disponible';
  return new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const decisionText = (value: string) => {
  const decision = value.toLowerCase();
  if (decision.includes('paper') || decision.includes('candidate')) return 'Candidato en papel';
  if (decision.includes('no_bet') || decision.includes('no bet') || decision.includes('no apostar')) return 'No apostar';
  return 'Informativo';
};

const decisionStyle = (value: string) => {
  const decision = value.toLowerCase();
  if (decision.includes('paper') || decision.includes('candidate')) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (decision.includes('no_bet') || decision.includes('no bet') || decision.includes('no apostar')) return 'border-slate-600 bg-slate-800 text-slate-300';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
};

const reasonLabel = (value: string) => ({
  model_not_promoted: 'modelo aún no promovido',
  model_contract_invalid: 'contrato de inferencia del modelo inválido',
  uncertainty_contract_missing: 'modelo sin contrato de incertidumbre validado',
  competition_shadow_gate_not_met: 'competición todavía en shadow mode',
  informational_market: 'mercado sólo informativo',
  insufficient_data: 'histórico insuficiente',
  official_lineup_missing: 'falta XI oficial',
  material_context_conflict: 'conflicto contextual material',
  context_review_pending: 'contexto material pendiente de revisión',
  fresh_odds_missing: 'falta cuota reciente',
  provider_data_stale: 'proveedor con datos incompletos o stale',
  conservative_edge_below_2pct: 'edge conservador menor a 2%',
  positive_ev_confidence_below_90pct: 'certeza de EV positivo menor a 90%',
  not_best_candidate_for_fixture: 'existe otra selección con mejor EV conservador',
  recommendation_expired_or_unavailable: 'recomendación vencida o no disponible',
}[value] ?? value);

const freshnessLabel = (value: string) => ({
  fresh: 'datos y cuota recientes',
  provider_stale: 'proveedor incompleto o stale; recomendación bloqueada',
  odds_unavailable: 'sin cuota reciente',
  unknown: 'sin estado de frescura',
}[value] ?? value);

const objectiveLabel = (key: string) => ({
  title: 'Título',
  european_places: 'Plazas europeas',
  survival: 'Permanencia',
  uefa_knockout: 'Playoff/eliminatoria UEFA',
  uefa_round_of_16: 'Clasificación a octavos',
}[key] ?? key);

const objectiveStateLabel = (value: string) => ({
  secured: 'Asegurado',
  alive: 'En juego',
  eliminated: 'Eliminado',
  conditional_external: 'Depende de factores externos',
  unknown: 'Sin confirmar',
}[value] ?? value);

const ObjectiveCard = ({
  team,
  objectives,
  restDays,
  matches14Days,
}: {
  team: string;
  objectives: Record<string, string>;
  restDays: number | null;
  matches14Days: number | null;
}) => (
  <article className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-4">
    <h3 className="font-bold text-slate-100">{team}</h3>
    <dl className="mt-3 space-y-2 text-sm">
      {(objectives.uefa_knockout || objectives.uefa_round_of_16
        ? ['uefa_knockout', 'uefa_round_of_16']
        : ['title', 'european_places', 'survival']).map((key) => (
        <div key={key} className="flex items-start justify-between gap-3">
          <dt className="text-slate-500">{objectiveLabel(key)}</dt>
          <dd className="text-right font-medium text-slate-300">{objectiveStateLabel(objectives[key] ?? 'unknown')}</dd>
        </div>
      ))}
      <div className="flex items-start justify-between gap-3 border-t border-slate-800 pt-2">
        <dt className="text-slate-500">Descanso</dt>
        <dd className="font-medium text-slate-300">{restDays === null ? 'Sin dato' : `${restDays.toFixed(1)} días`}</dd>
      </div>
      <div className="flex items-start justify-between gap-3">
        <dt className="text-slate-500">Partidos en 14 días</dt>
        <dd className="font-medium text-slate-300">{matches14Days ?? 'Sin dato'}</dd>
      </div>
    </dl>
  </article>
);

const ProbabilityTile = ({
  label,
  base,
  contextual,
  interval,
}: {
  label: string;
  base: number | null;
  contextual: number | null;
  interval: ProbabilityInterval | null;
}) => {
  const delta = base !== null && contextual !== null ? contextual - base : null;
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="text-2xl font-bold text-white">{probabilityText(contextual)}</p>
        {delta !== null && (
          <span className={`flex items-center text-xs font-semibold ${delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-slate-500'}`}>
            {delta > 0 ? <TrendingUp size={13} /> : delta < 0 ? <TrendingDown size={13} /> : null}
            {delta > 0 ? '+' : ''}{(delta * 100).toFixed(1)} pp
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">Base: {probabilityText(base)}</p>
      <p className="mt-1 text-[11px] text-slate-600">
        IC 90%: {interval ? `${probabilityText(interval.low)} – ${probabilityText(interval.high)}` : '—'}
      </p>
    </div>
  );
};

const ProbabilityGrid = ({ prediction }: { prediction: PredictionListItem }) => (
  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
    <ProbabilityTile label="Local" base={prediction.base.home} contextual={prediction.contextual.home} interval={prediction.intervals.home} />
    <ProbabilityTile label="Empate" base={prediction.base.draw} contextual={prediction.contextual.draw} interval={prediction.intervals.draw} />
    <ProbabilityTile label="Visitante" base={prediction.base.away} contextual={prediction.contextual.away} interval={prediction.intervals.away} />
    <ProbabilityTile label="Over 2.5" base={prediction.base.over25} contextual={prediction.contextual.over25} interval={prediction.intervals.over25} />
    <ProbabilityTile label="Under 2.5" base={prediction.base.under25} contextual={prediction.contextual.under25} interval={prediction.intervals.under25} />
    <ProbabilityTile label="Ambos marcan" base={prediction.base.bttsYes} contextual={prediction.contextual.bttsYes} interval={prediction.intervals.bttsYes} />
  </div>
);

const reviewLabel = (status: string, applied: boolean) => applied
  ? (status === 'rejected'
      ? 'Usada al corte · ahora rechazada'
      : status === 'corrected' ? 'Aplicada con corrección' : 'Aplicada en este snapshot')
  : ({
  approved: 'Revisada · no usada en este snapshot',
  corrected: 'Corregida · no usada en este snapshot',
  pending: 'Pendiente · no aplicada',
  rejected: 'Rechazada · no aplicada',
}[status] ?? `${status} · no aplicada`);

const reviewStyle = (status: string) => (
  ['approved', 'corrected'].includes(status)
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : status === 'rejected'
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
);

const ObservationList = ({
  observations,
  evidenceIds,
}: {
  observations: ContextObservationItem[];
  evidenceIds: Set<string>;
}) => (
  <div className="divide-y divide-slate-700/50">
    {observations.map((observation) => {
      const applied = evidenceIds.has(observation.id);
      return (
      <article key={observation.id} className={`py-4 first:pt-0 last:pb-0 ${observation.reviewStatus === 'rejected' ? 'opacity-65' : ''}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-slate-800 px-2.5 py-1 font-semibold text-slate-300">{observation.type}</span>
              <span className={`rounded-full border px-2.5 py-1 font-semibold ${reviewStyle(observation.reviewStatus === 'rejected' ? 'rejected' : applied ? 'approved' : observation.reviewStatus)}`}>{reviewLabel(observation.reviewStatus, applied)}</span>
              <span className="text-slate-400">Afecta a {observation.affectedEntity}</span>
              <span className="text-slate-500">Nivel {observation.authority}</span>
              <span className="text-slate-500">Certeza {probabilityText(observation.confidence)}</span>
              {observation.isConflicted && <span className="font-semibold text-red-300">Conflicto activo</span>}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-300">{observation.summary}</p>
            <p className="mt-2 text-[11px] text-slate-600">Publicada/observada: {dateTimeText(observation.publishedAt)} · Capturada: {dateTimeText(observation.fetchedAt)}</p>
          </div>
          {observation.sourceUrl && (
            <a href={observation.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300">
              Fuente <ExternalLink size={13} />
            </a>
          )}
        </div>
      </article>
      );
    })}
  </div>
);

const SquadCard = ({
  team,
  lineups,
  availability,
}: {
  team: string;
  lineups: LineupSummary[];
  availability: AvailabilitySummary[];
}) => {
  const lineup = lineups.find((item) => item.type === 'confirmed') ?? lineups[0];
  const relevantAvailability = availability.filter((item) => item.status !== 'available');
  return (
    <article className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-4">
      <h3 className="font-bold text-slate-100">{team}</h3>
      {lineup ? (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`rounded-full border px-2.5 py-1 font-semibold ${lineup.type === 'confirmed' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
              {lineup.type === 'confirmed' ? 'XI confirmado' : 'Escenario probable'}
            </span>
            <span className="text-slate-500">{lineup.formation ?? 'Formación sin dato'} · {lineup.sourceTier}</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-300">{lineup.starters.length ? lineup.starters.join(', ') : 'Jugadores aún no publicados.'}</p>
          <p className="mt-1 text-[11px] text-slate-600">Observado: {dateTimeText(lineup.observedAt)}</p>
        </div>
      ) : <p className="mt-3 text-sm text-slate-500">Sin XI ni escenarios estructurados.</p>}
      <div className="mt-4 border-t border-slate-800 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Disponibilidad relevante</p>
        {relevantAvailability.length ? (
          <ul className="mt-2 space-y-2 text-sm">
            {relevantAvailability.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3">
                <span className="text-slate-300">{item.playerName}</span>
                <span className="text-right text-slate-500">
                  {item.status}{item.probabilityAvailable === null ? '' : ` · ${probabilityText(item.probabilityAvailable)}`}
                  <span className="block text-[10px] text-slate-600">{dateTimeText(item.asOf)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-slate-500">Sin bajas estructuradas vigentes; no equivale a plantilla completa.</p>}
      </div>
    </article>
  );
};

export const PredictionDetail = () => {
  const { fixtureId = '' } = useParams();
  const [prediction, setPrediction] = useState<PredictionListItem | null>(null);
  const [observations, setObservations] = useState<ContextObservationItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceTeamId, setSourceTeamId] = useState('');
  const [submittingContext, setSubmittingContext] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const refreshRequest = useRef({ fixtureId, key: crypto.randomUUID() });

  const fetchDetail = async () => {
    setLoading(true);
    const [predictionResult, contextResult] = await Promise.all([
      loadPredictionDetail(fixtureId),
      loadContextObservations(fixtureId),
    ]);
    setPrediction(predictionResult.predictions[0] ?? null);
    setObservations(contextResult.observations.filter((item) => item.fixtureId === fixtureId));
    setWarnings([...predictionResult.warnings, ...contextResult.warnings]);
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadPredictionDetail(fixtureId),
      loadContextObservations(fixtureId),
    ]).then(([predictionResult, contextResult]) => {
      if (!active) return;
      setPrediction(predictionResult.predictions[0] ?? null);
      setObservations(contextResult.observations.filter((item) => item.fixtureId === fixtureId));
      setWarnings([...predictionResult.warnings, ...contextResult.warnings]);
      setLoading(false);
    });
    return () => { active = false; };
  }, [fixtureId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      if (refreshRequest.current.fixtureId !== fixtureId) {
        refreshRequest.current = { fixtureId, key: crypto.randomUUID() };
      }
      const result = await requestFixtureRefresh(fixtureId, refreshRequest.current.key);
      setMessage({
        type: 'success',
        text: result?.status === 'partial'
          ? 'Actualización parcial: se conservaron datos previos y no se habilitarán candidatos con fuentes stale.'
          : 'Actualización solicitada. El nuevo snapshot aparecerá cuando termine el proceso.',
      });
      await fetchDetail();
      refreshRequest.current = { fixtureId, key: crypto.randomUUID() };
    } catch {
      setMessage({ type: 'error', text: 'No se pudo solicitar la actualización. Revisa que la función y sus secretos estén desplegados.' });
    } finally {
      setRefreshing(false);
    }
  };

  const handleContextSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmittingContext(true);
    setMessage(null);
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
      await extractContextObservation(fixtureId, parsed.toString(), sourceTeamId || undefined);
      setSourceUrl('');
      setSourceTeamId('');
      setMessage({ type: 'success', text: 'Fuente analizada y enviada a la bandeja de revisión; aún no altera la predicción.' });
      await fetchDetail();
    } catch {
      setMessage({ type: 'error', text: 'No se pudo analizar la fuente. Debe ser HTTPS y pertenecer a un dominio permitido.' });
    } finally {
      setSubmittingContext(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-slate-400" role="status">
        <RefreshCw className="mr-3 animate-spin text-blue-400" size={20} /> Cargando análisis real…
      </div>
    );
  }

  if (!prediction) {
    return (
      <div className="mx-auto max-w-3xl p-4 md:p-8">
        <Link to="/predictions" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
          <ArrowLeft size={16} /> Volver a predicciones
        </Link>
        <section className="glass-card mt-6 rounded-2xl border border-slate-700/60 p-8 text-center">
          <CircleAlert className="mx-auto text-amber-400" size={34} />
          <h1 className="mt-4 text-xl font-bold">Predicción no disponible</h1>
          <p className="mt-2 text-sm text-slate-400">El partido no existe, no tiene un snapshot visible o aún no terminó la sincronización.</p>
          {warnings.length > 0 && <p className="mt-4 text-xs text-amber-300">Backend de predicciones pendiente de despliegue o acceso.</p>}
        </section>
      </div>
    );
  }

  const canRefresh = ['scheduled', 'postponed'].includes(prediction.fixtureStatus)
    && Boolean(prediction.kickoffAt && Date.parse(prediction.kickoffAt) > Date.now());
  const canRegisterRecommendation = Boolean(prediction.recommendation && canRefresh);
  const snapshotEvidenceIds = new Set(prediction.evidenceIds);
  const appliedObservations = observations.filter((item) => snapshotEvidenceIds.has(item.id));
  const unappliedObservations = observations.filter((item) => !snapshotEvidenceIds.has(item.id));

  const recommendationState = prediction.recommendation && canRegisterRecommendation
    ? {
        recommendation: {
          recommendationId: prediction.recommendation.id,
          fixtureId: prediction.fixtureId,
          selection: `${prediction.homeTeam} vs ${prediction.awayTeam} — ${prediction.recommendation.selection}`,
          odds: prediction.recommendation.offeredOdds,
          description: `Candidato en papel ${prediction.recommendation.market}. Modelo ${prediction.modelVersion}.`,
        },
      }
    : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-7 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link to="/predictions" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
          <ArrowLeft size={16} /> Volver a predicciones
        </Link>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing || !canRefresh}
          title={canRefresh ? 'Actualizar datos y recalcular el partido' : 'Sólo se actualizan partidos prepartido pendientes'}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-300 transition hover:bg-blue-500/20 disabled:opacity-50"
        >
          <RefreshCw className={refreshing ? 'animate-spin' : ''} size={17} />
          {refreshing ? 'Solicitando…' : 'Actualizar partido'}
        </button>
      </div>

      {message && (
        <div className={`rounded-xl border p-4 text-sm ${message.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`} role="status">
          {message.text}
        </div>
      )}

      <header className="glass-card rounded-2xl border border-slate-700/60 p-6 md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 font-semibold text-blue-300">{prediction.competitionName}</span>
              {prediction.stage && <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-slate-400">{prediction.stage}</span>}
              <span className={`rounded-full border px-3 py-1 font-semibold ${decisionStyle(prediction.decision)}`}>{decisionText(prediction.decision)}</span>
            </div>
            <h1 className="text-2xl font-bold text-white md:text-3xl">
              {prediction.homeTeam} <span className="font-normal text-slate-500">vs</span> {prediction.awayTeam}
            </h1>
            <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              <CalendarClock size={16} /> {dateTimeText(prediction.kickoffAt)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3 text-center">
              <p className="text-xs text-slate-500">λ local</p>
              <p className="mt-1 text-xl font-bold">{prediction.lambdaHome?.toFixed(2) ?? '—'}</p>
            </div>
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3 text-center">
              <p className="text-xs text-slate-500">λ visitante</p>
              <p className="mt-1 text-xl font-bold">{prediction.lambdaAway?.toFixed(2) ?? '—'}</p>
            </div>
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3 text-center">
              <p className="text-xs text-slate-500">Horizonte</p>
              <p className="mt-1 text-sm font-bold text-blue-300">{prediction.horizon}</p>
            </div>
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3 text-center">
              <p className="text-xs text-slate-500">Calidad</p>
              <p className="mt-1 text-sm font-bold text-slate-200">{prediction.dataQuality}</p>
            </div>
          </div>
        </div>
      </header>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Goal className="text-blue-400" size={19} />
          <h2 className="text-lg font-bold">Probabilidad final e impacto contextual</h2>
        </div>
        <ProbabilityGrid prediction={prediction} />
      </section>

      <section className="glass-card rounded-2xl border border-slate-700/60 p-5">
        <div className="mb-4">
          <h2 className="font-bold">Objetivos competitivos y carga</h2>
          <p className="mt-1 text-xs text-slate-500">Estados separados y verificables; nunca se resume como “no tiene nada que jugar”.</p>
        </div>
        {prediction.competitiveContext ? (
          <div className="grid gap-3 md:grid-cols-2">
            <ObjectiveCard
              team={prediction.homeTeam}
              objectives={prediction.competitiveContext.homeObjectives}
              restDays={prediction.competitiveContext.homeRestDays}
              matches14Days={prediction.competitiveContext.homeMatchesLast14Days}
            />
            <ObjectiveCard
              team={prediction.awayTeam}
              objectives={prediction.competitiveContext.awayObjectives}
              restDays={prediction.competitiveContext.awayRestDays}
              matches14Days={prediction.competitiveContext.awayMatchesLast14Days}
            />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-sm text-slate-500">Aún no existe un snapshot verificable de tabla y descanso.</p>
        )}
      </section>

      <section className="glass-card rounded-2xl border border-slate-700/60 p-5">
        <div className="mb-4">
          <h2 className="font-bold">Alineaciones y disponibilidad</h2>
          <p className="mt-1 text-xs text-slate-500">Datos estructurados por equipo, con estado y frescura; un vacío nunca se interpreta como “sin bajas”.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <SquadCard
            team={prediction.homeTeam}
            lineups={prediction.lineups.filter((item) => item.teamId === prediction.homeTeamId)}
            availability={prediction.availability.filter((item) => item.teamId === prediction.homeTeamId)}
          />
          <SquadCard
            team={prediction.awayTeam}
            lineups={prediction.lineups.filter((item) => item.teamId === prediction.awayTeamId)}
            availability={prediction.availability.filter((item) => item.teamId === prediction.awayTeamId)}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="glass-card rounded-2xl border border-slate-700/60 p-5">
          <div className="mb-5 flex items-center gap-3">
            <Layers3 className="text-violet-400" size={21} />
            <div>
              <h2 className="font-bold">Impactos estimados</h2>
              <p className="text-xs text-slate-500">Para {prediction.traceLabel || 'la selección mostrada'}; cambio en puntos porcentuales, no causal.</p>
            </div>
          </div>
          {prediction.impacts.length > 0 ? (
            <div className="space-y-3">
              {prediction.impacts.map((impact) => (
                <div key={impact.key} className="flex items-center justify-between rounded-xl border border-slate-700/50 bg-slate-900/35 px-4 py-3">
                  <span className="text-sm text-slate-300">{impact.label}</span>
                  <span className={`font-mono text-sm font-bold ${impact.value > 0 ? 'text-emerald-400' : impact.value < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                    {impact.value > 0 ? '+' : ''}{(impact.value * 100).toFixed(1)} pp
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-sm text-slate-500">Sin impactos contextuales publicados para este snapshot.</p>
          )}
        </section>

        <section className="glass-card rounded-2xl border border-slate-700/60 p-5">
          <div className="mb-5 flex items-center gap-3">
            <BookOpenCheck className="text-emerald-400" size={21} />
            <div>
              <h2 className="font-bold">Decisión y valor</h2>
              <p className="text-xs text-slate-500">La cuota no forma parte del modelo deportivo.</p>
            </div>
          </div>
          {prediction.recommendation ? (
            <div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="col-span-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <p className="text-xs text-slate-500">Selección</p>
                  <p className="mt-1 font-bold text-emerald-300">{prediction.recommendation.selection}</p>
                </div>
                <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-500">Cuota ofrecida</p>
                  <p className="mt-1 font-bold">{prediction.recommendation.offeredOdds?.toFixed(2) ?? '—'}</p>
                </div>
                <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-500">Cuota justa</p>
                  <p className="mt-1 font-bold">{prediction.recommendation.fairOdds?.toFixed(2) ?? '—'}</p>
                </div>
                <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-500">Edge conservador</p>
                  <p className="mt-1 font-bold">{prediction.recommendation.edge === null ? '—' : `${(prediction.recommendation.edge * 100).toFixed(1)}%`}</p>
                </div>
              </div>
              {canRegisterRecommendation ? (
                <Link
                  to="/new-bet"
                  state={recommendationState}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                >
                  Revisar y registrar en BetLedger <ChevronRight size={17} />
                </Link>
              ) : (
                <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center text-sm text-amber-200">
                  El partido ya no está en ventana prepartido; la recomendación no se puede registrar.
                </p>
              )}
              <p className="mt-2 text-center text-xs text-slate-500">Nada se registra sin tu confirmación y no se sugiere stake.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700 p-5 text-center">
              <ShieldCheck className="mx-auto text-slate-600" size={26} />
              <p className="mt-3 text-sm font-medium text-slate-300">{decisionText(prediction.decision)}</p>
              <p className="mt-1 text-xs text-slate-500">Trazabilidad de {prediction.traceLabel || 'la selección evaluada'}; no hay una recomendación elegible para registrar.</p>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-left text-xs sm:grid-cols-4">
                {[
                  ['Cuota justa', prediction.pricing.fairOdds?.toFixed(2) ?? '—'],
                  ['Cuota ofrecida', prediction.pricing.offeredOdds?.toFixed(2) ?? '—'],
                  ['Edge conservador', prediction.pricing.conservativeEdge === null ? '—' : `${(prediction.pricing.conservativeEdge * 100).toFixed(1)}%`],
                  ['P(EV positivo)', probabilityText(prediction.pricing.probabilityEvPositive)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-slate-900/60 p-2.5">
                    <dt className="text-slate-600">{label}</dt>
                    <dd className="mt-1 font-semibold text-slate-300">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="glass-card rounded-2xl border border-slate-700/60 p-5">
          <h2 className="font-bold">Marcadores más probables</h2>
          <p className="mt-1 text-xs text-slate-500">Informativos; derivados de la misma distribución, no son picks adicionales.</p>
          {prediction.topScores.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {prediction.topScores.map((score) => (
                <div key={`${score.home}-${score.away}`} className="rounded-xl border border-slate-700/60 bg-slate-900/45 p-3 text-center">
                  <p className="text-lg font-bold">{score.home}–{score.away}</p>
                  <p className="mt-1 text-xs text-slate-500">{probabilityText(score.probability)}</p>
                </div>
              ))}
            </div>
          ) : <p className="mt-4 text-sm text-slate-500">Sin distribución de marcadores publicada.</p>}
        </div>
        <div className="glass-card rounded-2xl border border-slate-700/60 p-5">
          <h2 className="font-bold">Clasificación UEFA</h2>
          <p className="mt-1 text-xs text-slate-500">Se mantiene separada del resultado 1X2 de 90 minutos.</p>
          {prediction.qualification?.available === true ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-center">
                <p className="text-xs text-slate-500">Clasifica {prediction.homeTeam}</p>
                <p className="mt-1 text-xl font-bold text-blue-300">{probabilityText(numericValue(prediction.qualification.home))}</p>
              </div>
              <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-center">
                <p className="text-xs text-slate-500">Clasifica {prediction.awayTeam}</p>
                <p className="mt-1 text-xl font-bold text-violet-300">{probabilityText(numericValue(prediction.qualification.away))}</p>
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-slate-700/60 bg-slate-900/45 p-4 text-sm text-slate-400">
              {typeof prediction.qualification?.reason === 'string'
                ? prediction.qualification.reason
                : 'No aplica o no hay estado agregado oficial suficiente.'}
            </p>
          )}
        </div>
      </section>

      <section className="glass-card rounded-2xl border border-slate-700/60 p-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserRoundCheck className="text-amber-400" size={21} />
            <div>
              <h2 className="font-bold">Evidencia contextual</h2>
              <p className="text-xs text-slate-500">Bajas, objetivos, descanso, alineaciones y fuentes revisadas.</p>
            </div>
          </div>
          <Link to="/context-review" className="text-sm font-semibold text-blue-400 hover:text-blue-300">Abrir bandeja de revisión</Link>
        </div>

        <form onSubmit={(event) => void handleContextSubmit(event)} className="mb-5 rounded-xl border border-slate-700/60 bg-slate-900/35 p-4">
          <label htmlFor="context-source" className="flex items-center gap-2 text-sm font-semibold text-slate-300">
            <Link2 size={16} className="text-blue-400" /> Añadir fuente para revisión
          </label>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
            <input
              id="context-source"
              type="url"
              required
              inputMode="url"
              placeholder="https://sitio-oficial.example/noticia"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500"
            />
            <select
              aria-label="Entidad afectada"
              value={sourceTeamId}
              onChange={(event) => setSourceTeamId(event.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500"
            >
              <option value="">Partido completo</option>
              <option value={prediction.homeTeamId}>{prediction.homeTeam}</option>
              <option value={prediction.awayTeamId}>{prediction.awayTeam}</option>
            </select>
            <button
              type="submit"
              disabled={submittingContext || !sourceUrl.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              <Send size={15} /> {submittingContext ? 'Analizando…' : 'Enviar'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Sólo se guarda una paráfrasis factual y el enlace. Todo hallazgo requiere revisión humana.</p>
        </form>

        {observations.length > 0 ? (
          <div className="space-y-6">
            <div>
              <h3 className="mb-3 text-sm font-semibold text-emerald-300">Incluida en el corte del snapshot ({appliedObservations.length})</h3>
              {appliedObservations.length
                ? <ObservationList observations={appliedObservations} evidenceIds={snapshotEvidenceIds} />
                : <p className="text-sm text-slate-500">Ninguna fuente revisada fue aplicada.</p>}
            </div>
            <div className="border-t border-slate-800 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-amber-300">Pendiente o descartada · no aplicada ({unappliedObservations.length})</h3>
              {unappliedObservations.length
                ? <ObservationList observations={unappliedObservations} evidenceIds={snapshotEvidenceIds} />
                : <p className="text-sm text-slate-500">No hay hallazgos pendientes ni rechazados.</p>}
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-sm text-slate-500">No hay observaciones reales asociadas a este partido.</p>
        )}
      </section>

      <footer className="flex flex-wrap gap-x-6 gap-y-2 border-t border-slate-800 pt-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><Clock3 size={13} /> Corte: {dateTimeText(prediction.cutoffAt)}</span>
        <span>Modelo: {prediction.modelVersion}</span>
        <span>Estado del fixture: {prediction.fixtureStatus}</span>
        <span>Frescura: {freshnessLabel(prediction.sourceFreshness)}</span>
        {prediction.oddsObservedAt && <span>Cuota observada: {dateTimeText(prediction.oddsObservedAt)}</span>}
        {prediction.reasons.length > 0 && <span>Bloqueos: {prediction.reasons.map(reasonLabel).join(', ')}</span>}
      </footer>
    </div>
  );
};
