import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { useAuth } from './useAuth';

const MembershipFailure = ({ retry, signOut }: { retry: () => void; signOut: () => Promise<void> }) => (
  <div className="min-h-screen bg-[#0f172a] p-4 text-slate-300 flex items-center justify-center">
    <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-slate-900 p-6 text-center">
      <h1 className="text-lg font-bold text-white">No se pudo verificar el acceso privado</h1>
      <p className="mt-2 text-sm text-slate-400">Puede ser un error temporal de red. No se cerró tu sesión.</p>
      <div className="mt-5 flex justify-center gap-3">
        <button type="button" onClick={retry} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Reintentar</button>
        <button type="button" onClick={() => void signOut()} className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800">Cerrar sesión</button>
      </div>
    </div>
  </div>
);

export const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const { user, isOwner, loading, membershipError, retryMembership, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-300 flex items-center justify-center">
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <LoaderCircle className="animate-spin text-blue-400" size={22} />
          Verificando sesión…
        </div>
      </div>
    );
  }

  if (user && membershipError) {
    return <MembershipFailure retry={retryMembership} signOut={signOut} />;
  }

  if (!user || !isOwner) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
};

export const PublicOnlyRoute = ({ children }: { children: ReactNode }) => {
  const { user, isOwner, loading, membershipError, retryMembership, signOut } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-300 flex items-center justify-center">
        <LoaderCircle className="animate-spin text-blue-400" size={22} />
      </div>
    );
  }

  if (user && membershipError) {
    return <MembershipFailure retry={retryMembership} signOut={signOut} />;
  }

  return user && isOwner ? <Navigate to="/predictions" replace /> : children;
};
