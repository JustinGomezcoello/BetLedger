import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Home, ListFilter, PlusCircle, Settings as SettingsIcon, Globe } from 'lucide-react';
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { Dashboard } from './pages/Dashboard';
import { BetsList } from './pages/BetsList';
import { NewBet } from './pages/NewBet';
import { Settings } from './pages/Settings';

export function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

// Sidebar Link Component
const NavLink = ({ to, icon: Icon, children, onClick }: { to: string; icon: any; children: React.ReactNode; onClick?: () => void }) => {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        "flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-200 group",
        isActive
          ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
          : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
      )}
    >
      <Icon size={20} className={cn("transition-colors", isActive ? "text-blue-400" : "group-hover:text-blue-400")} />
      <span className="font-medium">{children}</span>
    </Link>
  );
};

function App() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const { t, i18n } = useTranslation();

  const toggleLanguage = () => {
    i18n.changeLanguage(i18n.language === 'es' ? 'en' : 'es');
  };

  return (
    <Router>
      <div className="min-h-screen bg-[#0f172a] text-white flex flex-col md:flex-row">

        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between p-4 border-b border-slate-700/50 glass-card z-30 sticky top-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              BetLedger
            </h1>
            <button onClick={toggleLanguage} className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-bold text-slate-300 flex items-center gap-1">
              <Globe size={14} /> {i18n.language === 'es' ? 'EN' : 'ES'}
            </button>
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="p-2 text-slate-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isMobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} /></svg>
          </button>
        </div>

        {/* Sidebar */}
        <aside className={cn(
          "w-full md:w-64 glass-card border-r border-slate-700/50 flex flex-col z-20 md:sticky md:top-0 md:h-screen fixed h-[calc(100vh-65px)] top-[65px] transition-transform duration-300 md:translate-x-0 bg-[#0f172a]/95 md:bg-transparent backdrop-blur-xl",
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        )}>
          <div className="p-6 hidden md:block">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
                BetLedger
              </h1>
              <button onClick={toggleLanguage} className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-bold text-slate-300 hover:text-white hover:bg-slate-700 transition flex items-center justify-center min-w-[36px]">
                {i18n.language === 'es' ? 'EN' : 'ES'}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1 uppercase tracking-wider font-semibold">{t('app.edition')}</p>
          </div>

          <nav className="flex-1 px-4 space-y-2 mt-4 md:mt-0">
            <NavLink onClick={() => setIsMobileMenuOpen(false)} to="/" icon={Home}>{t('app.dashboard')}</NavLink>
            <NavLink onClick={() => setIsMobileMenuOpen(false)} to="/new-bet" icon={PlusCircle}>{t('app.newBet')}</NavLink>
            <NavLink onClick={() => setIsMobileMenuOpen(false)} to="/history" icon={ListFilter}>{t('app.history')}</NavLink>
          </nav>

          <div className="p-4 border-t border-slate-700/50 mb-4 md:mb-0">
            <Link onClick={() => setIsMobileMenuOpen(false)} to="/settings" className="flex items-center space-x-3 px-4 py-3 rounded-xl hover:bg-slate-800/50 text-slate-300 transition-colors">
              <SettingsIcon size={20} />
              <span>{t('app.settings')}</span>
            </Link>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/new-bet" element={<NewBet />} />
            <Route path="/history" element={<BetsList />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
