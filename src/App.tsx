import React from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ClipboardCheck,
  Globe,
  Goal,
  Home,
  ListFilter,
  LogOut,
  PlusCircle,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute, PublicOnlyRoute } from './auth/ProtectedRoute';
import { useAuth } from './auth/useAuth';
import { cn } from './lib/cn';

const Dashboard = React.lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })));
const Predictions = React.lazy(() => import('./pages/Predictions').then((module) => ({ default: module.Predictions })));
const PredictionDetail = React.lazy(() => import('./pages/PredictionDetail').then((module) => ({ default: module.PredictionDetail })));
const ReviewQueue = React.lazy(() => import('./pages/ReviewQueue').then((module) => ({ default: module.ReviewQueue })));
const NewBet = React.lazy(() => import('./pages/NewBet').then((module) => ({ default: module.NewBet })));
const BetsList = React.lazy(() => import('./pages/BetsList').then((module) => ({ default: module.BetsList })));
const Settings = React.lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })));
const Login = React.lazy(() => import('./pages/Login').then((module) => ({ default: module.Login })));
const ForgotPassword = React.lazy(() => import('./pages/ForgotPassword').then((module) => ({ default: module.ForgotPassword })));
const ResetPassword = React.lazy(() => import('./pages/ResetPassword').then((module) => ({ default: module.ResetPassword })));

const RouteLoader = () => (
  <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-400" role="status">
    Cargando…
  </div>
);

type NavLinkProps = {
  to: string;
  icon: LucideIcon;
  children: React.ReactNode;
  onClick?: () => void;
};

const NavLink = ({ to, icon: Icon, children, onClick }: NavLinkProps) => {
  const location = useLocation();
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        'group flex items-center space-x-3 rounded-xl px-4 py-3 transition-all duration-200',
        isActive
          ? 'border border-blue-500/30 bg-blue-600/20 text-blue-400'
          : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200',
      )}
    >
      <Icon size={20} className={cn('transition-colors', isActive ? 'text-blue-400' : 'group-hover:text-blue-400')} />
      <span className="font-medium">{children}</span>
    </Link>
  );
};

const AppShell = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const { t, i18n } = useTranslation();
  const { user, signOut } = useAuth();
  const closeMenu = () => setIsMobileMenuOpen(false);
  const toggleLanguage = () => void i18n.changeLanguage(i18n.language === 'es' ? 'en' : 'es');

  return (
    <div className="flex min-h-screen flex-col bg-[#0f172a] text-white md:flex-row">
      <header className="glass-card sticky top-0 z-30 flex items-center justify-between border-b border-slate-700/50 p-4 md:hidden">
        <div className="flex items-center gap-3">
          <h1 className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-xl font-bold text-transparent">BetLedger</h1>
          <button type="button" onClick={toggleLanguage} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-xs font-bold text-slate-300">
            <Globe size={14} /> {i18n.language === 'es' ? 'EN' : 'ES'}
          </button>
        </div>
        <button type="button" onClick={() => setIsMobileMenuOpen((open) => !open)} className="p-2 text-slate-400 hover:text-white" aria-label={t('app.openMenu')}>
          <span aria-hidden="true" className="text-xl">{isMobileMenuOpen ? '×' : '☰'}</span>
        </button>
      </header>

      <aside className={cn(
        'glass-card fixed top-[65px] z-20 flex h-[calc(100vh-65px)] w-full flex-col border-r border-slate-700/50 bg-[#0f172a]/95 backdrop-blur-xl transition-transform duration-300 md:sticky md:top-0 md:h-screen md:w-64 md:translate-x-0 md:bg-transparent',
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="hidden p-6 md:block">
          <div className="flex items-center justify-between">
            <h1 className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-2xl font-bold text-transparent">BetLedger</h1>
            <button type="button" onClick={toggleLanguage} className="min-w-9 rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-xs font-bold text-slate-300 hover:bg-slate-700 hover:text-white">
              {i18n.language === 'es' ? 'EN' : 'ES'}
            </button>
          </div>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Motor contextual privado</p>
        </div>

        <nav className="mt-4 flex-1 space-y-2 px-4 md:mt-0">
          <NavLink onClick={closeMenu} to="/" icon={Home}>{t('app.dashboard')}</NavLink>
          <NavLink onClick={closeMenu} to="/predictions" icon={Goal}>Predicciones</NavLink>
          <NavLink onClick={closeMenu} to="/context-review" icon={ClipboardCheck}>Contexto por revisar</NavLink>
          <NavLink onClick={closeMenu} to="/new-bet" icon={PlusCircle}>{t('app.newBet')}</NavLink>
          <NavLink onClick={closeMenu} to="/history" icon={ListFilter}>{t('app.history')}</NavLink>
        </nav>

        <div className="space-y-2 border-t border-slate-700/50 p-4">
          <Link onClick={closeMenu} to="/settings" className="flex items-center space-x-3 rounded-xl px-4 py-3 text-slate-300 transition-colors hover:bg-slate-800/50">
            <SettingsIcon size={20} /><span>{t('app.settings')}</span>
          </Link>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center space-x-3 rounded-xl px-4 py-3 text-left text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut size={20} /><span>Cerrar sesión</span>
          </button>
          <p className="truncate px-4 text-[11px] text-slate-600" title={user?.email}>{user?.email}</p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <React.Suspense fallback={<RouteLoader />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/predictions" element={<Predictions />} />
            <Route path="/predictions/:fixtureId" element={<PredictionDetail />} />
            <Route path="/context-review" element={<ReviewQueue />} />
            <Route path="/new-bet" element={<NewBet />} />
            <Route path="/history" element={<BetsList />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </React.Suspense>
      </main>
    </div>
  );
};

const App = () => (
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <AuthProvider>
      <React.Suspense fallback={<RouteLoader />}>
        <Routes>
          <Route path="/login" element={<PublicOnlyRoute><Login /></PublicOnlyRoute>} />
          <Route path="/forgot-password" element={<PublicOnlyRoute><ForgotPassword /></PublicOnlyRoute>} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/*" element={<ProtectedRoute><AppShell /></ProtectedRoute>} />
        </Routes>
      </React.Suspense>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
