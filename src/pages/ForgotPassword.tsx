import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Mail, Send } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage('');

    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });

    if (error) {
      setErrorMessage('No fue posible enviar el enlace. Inténtalo nuevamente.');
      setSubmitting(false);
      return;
    }

    setSent(true);
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex items-center justify-center p-4">
      <main className="w-full max-w-md">
        <Link to="/login" className="mb-5 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
          <ArrowLeft size={16} /> Volver al acceso
        </Link>

        <section className="glass-card rounded-2xl border border-slate-700/60 p-6 md:p-8 shadow-2xl">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300">
            <Mail size={23} />
          </div>
          <h1 className="text-2xl font-bold">Recuperar contraseña</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Si el correo corresponde al propietario, recibirás un enlace de recuperación seguro.
          </p>

          {sent ? (
            <div role="status" className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
              Solicitud recibida. Revisa tu bandeja de entrada y también la carpeta de spam.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {errorMessage && (
                <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {errorMessage}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="recovery-email" className="text-sm font-medium text-slate-300">Correo del propietario</label>
                <input
                  id="recovery-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                  className="w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 font-semibold transition hover:bg-blue-500 disabled:opacity-60"
              >
                <Send size={18} /> {submitting ? 'Enviando…' : 'Enviar enlace'}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
};
