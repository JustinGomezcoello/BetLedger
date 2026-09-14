import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Pencil, RefreshCw, ShieldCheck, X } from 'lucide-react';
import {
  loadContextObservations,
  submitContextReview,
} from '../lib/prediction-data';
import type { ContextObservationItem } from '../lib/prediction-data';

const dateText = (value: string | null) => {
  if (!value) return 'Fecha no disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Fecha no disponible'
    : new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

export const ReviewQueue = () => {
  const [observations, setObservations] = useState<ContextObservationItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [correctionId, setCorrectionId] = useState<string | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const reviewRequests = useRef(new Map<string, string>());

  const reload = async () => {
    setLoading(true);
    const result = await loadContextObservations();
    setObservations(result.observations);
    setWarnings(result.warnings);
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    void loadContextObservations().then((result) => {
      if (!active) return;
      setObservations(result.observations);
      setWarnings(result.warnings);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const pending = observations.filter((item) => item.reviewStatus === 'pending');

  const review = async (id: string, decision: 'approved' | 'corrected' | 'rejected', correctedSummary?: string) => {
    setActiveId(id);
    setMessage(null);
    const fingerprint = `${id}:${decision}:${correctedSummary ?? ''}`;
    const idempotencyKey = reviewRequests.current.get(fingerprint) ?? crypto.randomUUID();
    reviewRequests.current.set(fingerprint, idempotencyKey);
    try {
      await submitContextReview(id, decision, correctedSummary, idempotencyKey);
      reviewRequests.current.delete(fingerprint);
      setMessage(decision === 'approved' ? 'Evidencia aprobada y auditada.' : decision === 'corrected' ? 'Evidencia corregida y auditada.' : 'Evidencia rechazada.');
      setCorrectionId(null);
      setCorrectionText('');
      await reload();
    } catch {
      setMessage('No se pudo guardar la revisión. Comprueba que la función backend esté desplegada.');
    } finally {
      setActiveId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Contexto por revisar</h1>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-sm font-semibold text-amber-300">
              {pending.length} pendientes
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-slate-400">
            Ninguna noticia no estructurada afecta una recomendación sin revisión humana y trazabilidad.
          </p>
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
          <RefreshCw className={loading ? 'animate-spin' : ''} size={17} /> Actualizar
        </button>
      </header>

      {message && <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-blue-200" role="status">{message}</div>}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200" role="alert">
          La base de contexto aún no está completamente disponible. Aplica las migraciones y despliega las funciones para habilitarla.
        </div>
      )}

      {loading ? (
        <div className="glass-card flex min-h-48 items-center justify-center rounded-2xl text-slate-400"><RefreshCw className="mr-3 animate-spin" size={19} /> Cargando evidencias…</div>
      ) : pending.length === 0 ? (
        <section className="glass-card rounded-2xl border border-slate-700/60 p-8 text-center">
          <ShieldCheck className="mx-auto text-emerald-400" size={35} />
          <h2 className="mt-4 text-xl font-semibold">No hay evidencias pendientes</h2>
          <p className="mt-2 text-sm text-slate-400">Las observaciones aprobadas y rechazadas conservan su historial en la base de datos.</p>
        </section>
      ) : (
        <section className="space-y-4">
          {pending.map((observation) => (
            <article key={observation.id} className="glass-card overflow-hidden rounded-2xl border border-amber-500/20">
              <div className="flex items-start gap-3 border-b border-amber-500/15 bg-amber-500/5 p-4">
                <AlertCircle className="mt-0.5 shrink-0 text-amber-400" size={20} />
                <div className="min-w-0">
                  <p className="font-semibold text-amber-200">{observation.type} · {observation.fixtureLabel}</p>
                  <p className="mt-1 text-xs font-medium text-slate-400">Afecta a: {observation.affectedEntity}</p>
                  <p className="mt-1 text-xs text-slate-500">{dateText(observation.publishedAt ?? observation.fetchedAt)}</p>
                </div>
              </div>
              <div className="space-y-4 p-5">
                <p className="leading-7 text-slate-200">{observation.summary}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-slate-300">Fuente: {observation.authority}</span>
                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-slate-300">Confianza: {observation.confidence === null ? '—' : `${(observation.confidence * 100).toFixed(0)}%`}</span>
                  {observation.isConflicted && <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 font-semibold text-red-300">En conflicto</span>}
                  {observation.sourceUrl && <a href={observation.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue-400 hover:text-blue-300">Abrir fuente <ExternalLink size={13} /></a>}
                </div>
                <div className="flex flex-col gap-3 border-t border-slate-700/50 pt-4 sm:flex-row sm:justify-end">
                  <button type="button" onClick={() => void review(observation.id, 'rejected')} disabled={activeId !== null} className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50"><X size={16} /> Rechazar</button>
                  <button type="button" onClick={() => { setCorrectionId(observation.id); setCorrectionText(observation.summary); }} disabled={activeId !== null} className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-300 hover:bg-blue-500/20 disabled:opacity-50"><Pencil size={16} /> Corregir</button>
                  <button type="button" onClick={() => void review(observation.id, 'approved')} disabled={activeId !== null} className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"><Check size={16} /> Aprobar</button>
                </div>
                {correctionId === observation.id && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void review(observation.id, 'corrected', correctionText.trim());
                    }}
                    className="space-y-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4"
                  >
                    <label htmlFor={`correction-${observation.id}`} className="text-sm font-semibold text-blue-200">Paráfrasis factual corregida</label>
                    <textarea id={`correction-${observation.id}`} required minLength={1} maxLength={1000} value={correctionText} onChange={(event) => setCorrectionText(event.target.value)} className="min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 outline-none focus:border-blue-500" />
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setCorrectionId(null)} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white">Cancelar</button>
                      <button type="submit" disabled={activeId !== null || !correctionText.trim()} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Guardar corrección</button>
                    </div>
                  </form>
                )}
              </div>
            </article>
          ))}
        </section>
      )}

      <aside className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 text-xs leading-5 text-slate-500">
        Aprobar una noticia permite crear escenarios contextuales, pero no elimina los bloqueos por fuente no oficial, conflicto, cuota vencida o alineación sin confirmar.
      </aside>
    </div>
  );
};
