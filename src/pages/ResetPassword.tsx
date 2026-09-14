import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export const ResetPassword = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setReady(Boolean(data.session)));

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setReady(true);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');

    if (password.length < 12) {
      setErrorMessage('Usa al menos 12 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setErrorMessage('Las contraseñas no coinciden.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setErrorMessage('No fue posible cambiar la contraseña. Solicita un enlace nuevo.');
      setSubmitting(false);
      return;
    }

    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex items-center justify-center p-4">
      <main className="w-full max-w-md">
        <section className="glass-card rounded-2xl border border-slate-700/60 p-6 md:p-8 shadow-2xl">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
            <KeyRound size={23} />
          </div>
          <h1 className="text-2xl font-bold">Crear contraseña nueva</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">Usa una contraseña única de al menos 12 caracteres.</p>

          {!ready ? (
            <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
              El enlace no contiene una sesión de recuperación válida o ya venció.
              <Link to="/forgot-password" className="mt-3 block font-semibold text-amber-100 underline">Solicitar otro enlace</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {errorMessage && (
                <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {errorMessage}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="new-password" className="text-sm font-medium text-slate-300">Contraseña nueva</label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={12}
                  required
                  autoFocus
                  className="w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="confirm-password" className="text-sm font-medium text-slate-300">Repetir contraseña</label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  minLength={12}
                  required
                  className="w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-semibold transition hover:bg-emerald-500 disabled:opacity-60"
              >
                <ShieldCheck size={18} /> {submitting ? 'Guardando…' : 'Guardar contraseña'}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
};
