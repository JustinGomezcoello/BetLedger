import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, CalendarDays, CircleAlert, Database, Filter, Goal, Info, RefreshCw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { loadPredictions, requestFootballSync } from '../lib/prediction-data';
import type { PredictionListItem } from '../lib/prediction-data';

const COMPETITIONS = [
  { value: 'all', label: 'Todas las competiciones' },
  { value: 'premier', label: 'Premier League' },
  { value: 'laliga', label: 'La Liga' },
  { value: 'bundesliga', label: 'Bundesliga' },
  { value: 'champions', label: 'Champions League' },
  { value: 'europa', label: 'Europa League' },
  { value: 'conference', label: 'Conference League' },
];

const COMPETITION_CODES: Record<string, string> = {
  premier: 'PL',
  laliga: 'PD',
  bundesliga: 'BL1',
  champions: 'UCL',
  europa: 'UEL',
  conference: 'UECL',
};

const formatProbability = (value: number | null) => (
  value === null ? '—' : `${(value * 100).toFixed(1)}%`
);

const formatKickoff = (value: string | null) => {
  if (!value) return 'Hora pendiente';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Hora pendiente';
  return new Intl.DateTimeFormat('es-EC', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const normalizedCompetition = (prediction: PredictionListItem) => (
  `${prediction.competitionCode} ${prediction.competitionName}`.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
);

const matchesCompetition = (prediction: PredictionListItem, selected: string) => {
  if (selected === 'all') return true;
  if (prediction.competitionCode.toUpperCase() === COMPETITION_CODES[selected]) return true;
  const source = normalizedCompetition(prediction);
  const aliases: Record<string, string[]> = {
    premier: ['premierleague', 'england'],
    laliga: ['laliga', 'primeradivision', 'spain'],
    bundesliga: ['bundesliga', 'germany'],
    champions: ['championsleague'],
    europa: ['europaleague'],
    conference: ['conferenceleague'],
  };
  return aliases[selected]?.some((alias) => source.includes(alias)) ?? false;
};

const decisionLabel = (decision: string) => {
  const normalized = decision.toLowerCase();
  if (normalized.includes('paper') || normalized.includes('candidate')) return 'Candidato en papel';
  if (normalized.includes('no_bet') || normalized.includes('no bet') || normalized.includes('no apostar')) return 'No apostar';
  return 'Informativo';
};

const decisionClass = (decision: string) => {
  const normalized = decision.toLowerCase();
  if (normalized.includes('paper') || normalized.includes('candidate')) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (normalized.includes('no_bet') || normalized.includes('no bet') || normalized.includes('no apostar')) return 'border-slate-600 bg-slate-800 text-slate-300';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
};

const PredictionCard = ({ prediction }: { prediction: PredictionListItem }) => (
  <article className="glass-card rounded-2xl border border-slate-700/60 p-5 transition hover:border-blue-500/40 hover:bg-slate-800/70">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 lg:w-[34%]">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 font-semibold text-blue-300">
            {prediction.competitionName}
          </span>
          <span className={`rounded-full border px-2.5 py-1 font-semibold ${decisionClass(prediction.decision)}`}>
            {decisionLabel(prediction.decision)}
          </span>
        </div>
        <h2 className="truncate text-lg font-bold text-white">
          {prediction.homeTeam} <span className="font-normal text-slate-500">vs</span> {prediction.awayTeam}
        </h2>
        <p className="mt-1 flex items-center gap-2 text-sm text-slate-400">
          <CalendarDays size={15} /> {formatKickoff(prediction.kickoffAt)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          λ local {prediction.lambdaHome?.toFixed(2) ?? '—'} · λ visitante {prediction.lambdaAway?.toFixed(2) ?? '—'}
        </p>
      </div>

      <div className="grid flex-1 grid-cols-3 gap-2 sm:grid-cols-5">
        {[
          ['Local', prediction.contextual.home],
          ['Empate', prediction.contextual.draw],
          ['Visitante', prediction.contextual.away],
          ['Over 2.5', prediction.contextual.over25],
          ['Under 2.5', prediction.contextual.under25],
        ].map(([label, probability]) => (
          <div key={String(label)} className="rounded-xl border border-slate-700/60 bg-slate-900/45 px-3 py-3 text-center">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{String(label)}</p>
            <p className="mt-1 text-lg font-bold text-slate-100">{formatProbability(probability as number | null)}</p>
          </div>
        ))}
      </div>

      <Link
        to={`/predictions/${prediction.fixtureId}`}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm font-semibold text-blue-300 transition hover:bg-blue-500/20"
      >
        Ver análisis <ArrowRight size={17} />
      </Link>
    </div>
  </article>
);

const DemoCard = () => (
  <section className="rounded-2xl border border-dashed border-amber-500/35 bg-amber-500/5 p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-300">
          Demo matemático · no es un partido real
        </span>
        <h3 className="mt-3 text-lg font-bold text-white">Compatibilidad con la calculadora Over/Under</h3>
        <p className="mt-1 text-sm text-slate-400">Valida el cálculo Poisson del Excel mientras llegan datos reales.</p>
      </div>
      <Sparkles className="text-amber-300" size={25} />
    </div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        ['λ local', '1.9814'],
        ['λ visitante', '1.2299'],
        ['Over 2.5', '62.24%'],
        ['Under 2.5', '37.76%'],
      ].map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-700/60 bg-slate-900/55 p-3">
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-xl font-bold text-slate-100">{value}</p>
        </div>
      ))}
    </div>
  </section>
);

export const Predictions = () => {
  const [predictions, setPredictions] = useState<PredictionListItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCompetition, setSelectedCompetition] = useState('all');
  const [selectedDate, setSelectedDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const syncRequest = useRef({ fingerprint: '', key: crypto.randomUUID() });

  const fetchPredictions = async () => {
    setLoading(true);
    const result = await loadPredictions();
    setPredictions(result.predictions);
    setWarnings(result.warnings);
    setLoading(false);
  };

  const synchronize = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const fingerprint = `${selectedCompetition}:${selectedDate}`;
      if (syncRequest.current.fingerprint !== fingerprint) {
        syncRequest.current = { fingerprint, key: crypto.randomUUID() };
      }
      const result = await requestFootballSync({
        competitionCode: COMPETITION_CODES[selectedCompetition],
        date: selectedDate || undefined,
      }, syncRequest.current.key);
      setSyncMessage(result?.queued
        ? 'Solicitud en cola: faltan credenciales de proveedor en el servidor.'
        : `Sincronización ${result?.status ?? 'aceptada'}; se recargó la vista.`);
      await fetchPredictions();
      syncRequest.current = { fingerprint, key: crypto.randomUUID() };
    } catch {
      setSyncMessage('No se pudo sincronizar. Comprueba funciones, secretos y cuota diaria.');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    let active = true;
    void loadPredictions().then((result) => {
      if (!active) return;
      setPredictions(result.predictions);
      setWarnings(result.warnings);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const filteredPredictions = useMemo(() => predictions.filter((prediction) => {
    const competitionMatches = matchesCompetition(prediction, selectedCompetition);
    if (!selectedDate) return competitionMatches;
    if (!prediction.kickoffAt) return false;
    const kickoff = new Date(prediction.kickoffAt);
    if (Number.isNaN(kickoff.getTime())) return false;
    const localDate = [
      kickoff.getFullYear(),
      String(kickoff.getMonth() + 1).padStart(2, '0'),
      String(kickoff.getDate()).padStart(2, '0'),
    ].join('-');
    return competitionMatches && localDate === selectedDate;
  }), [predictions, selectedCompetition, selectedDate]);

  return (
    <div className="mx-auto max-w-7xl space-y-7 p-4 md:p-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-300">
            <Goal size={18} /> Motor contextual
          </div>
          <h1 className="text-3xl font-bold text-white">Predicciones</h1>
          <p className="mt-2 max-w-2xl text-slate-400">
            Probabilidades calibradas antes del partido. Una recomendación puede ser legítimamente “no apostar”.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void fetchPredictions()}
            disabled={loading || syncing}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} size={17} /> Recargar vista
          </button>
          <button
            type="button"
            onClick={() => void synchronize()}
            disabled={loading || syncing}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            <Database className={syncing ? 'animate-pulse' : ''} size={17} /> {syncing ? 'Sincronizando…' : 'Actualizar datos'}
          </button>
        </div>
      </header>

      {syncMessage && (
        <p className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-200" role="status">{syncMessage}</p>
      )}

      <section className="glass-card rounded-2xl border border-slate-700/60 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
          <label className="relative">
            <span className="sr-only">Competición</span>
            <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={17} />
            <select
              value={selectedCompetition}
              onChange={(event) => setSelectedCompetition(event.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-700 bg-slate-900/70 py-3 pl-10 pr-4 text-sm text-slate-200 outline-none focus:border-blue-500"
            >
              {COMPETITIONS.map((competition) => <option key={competition.value} value={competition.value}>{competition.label}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Fecha</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-200 outline-none focus:border-blue-500"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setSelectedCompetition('all');
              setSelectedDate('');
            }}
            className="rounded-xl px-4 py-3 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            Limpiar filtros
          </button>
        </div>
      </section>

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200" role="alert">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 shrink-0" size={18} />
            <div>
              <p className="font-semibold">El backend de predicciones todavía no está completamente disponible.</p>
              <p className="mt-1 text-amber-200/75">Los datos reales aparecerán aquí cuando terminen la migración y la primera sincronización.</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="glass-card flex min-h-48 items-center justify-center rounded-2xl text-slate-400" role="status">
          <RefreshCw className="mr-3 animate-spin text-blue-400" size={19} /> Cargando predicciones reales…
        </div>
      ) : filteredPredictions.length > 0 ? (
        <section className="space-y-3" aria-label="Partidos con predicción">
          <div className="flex items-center justify-between text-sm text-slate-500">
            <span>{filteredPredictions.length} {filteredPredictions.length === 1 ? 'partido' : 'partidos'}</span>
            <span className="flex items-center gap-1.5"><Activity size={15} /> Último snapshot por partido</span>
          </div>
          {filteredPredictions.map((prediction) => <PredictionCard key={prediction.id} prediction={prediction} />)}
        </section>
      ) : (
        <section className="glass-card rounded-2xl border border-slate-700/60 p-7 text-center">
          <Database className="mx-auto text-slate-600" size={36} />
          <h2 className="mt-4 text-xl font-semibold text-white">Sin predicciones reales para este filtro</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-400">
            No fabricamos partidos ni señales. Ejecuta la sincronización de datos o cambia los filtros cuando existan snapshots válidos.
          </p>
        </section>
      )}

      {predictions.length === 0 && <DemoCard />}

      <aside className="flex items-start gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-slate-400">
        <Info className="mt-0.5 shrink-0 text-blue-400" size={18} />
        <p>Las probabilidades son estimaciones, no garantías. El modo inicial es de seguimiento en papel y no coloca apuestas automáticamente.</p>
      </aside>
    </div>
  );
};
