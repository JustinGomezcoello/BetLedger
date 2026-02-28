import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Wallet, TrendingUp, TrendingDown, Activity, AlertCircle, Info } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from 'react-i18next';

const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
};

const StatCard = ({ title, value, subValue, trend, icon: Icon, infoText }: any) => (
    <div className="glass-card p-6 rounded-2xl border border-slate-700/50 relative overflow-visible group">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl" />
        <div className="flex justify-between items-start relative z-10">
            <div className="relative">
                <div className="flex items-center gap-1.5">
                    <p className="text-slate-400 text-sm font-medium">{title}</p>
                    {infoText && (
                        <div className="group/tooltip relative flex items-center justify-center">
                            <Info size={14} className="text-slate-500 hover:text-blue-400 cursor-help transition-colors" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-3 bg-slate-900 text-xs text-slate-200 rounded-lg border border-slate-700 opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all shadow-2xl z-[100] text-center pointer-events-none font-medium leading-relaxed">
                                {infoText}
                                <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-[1px] border-[6px] border-transparent border-t-slate-700"></div>
                            </div>
                        </div>
                    )}
                </div>
                <h3 className="text-3xl font-bold text-white mt-2">{value}</h3>
                {subValue && (
                    <p className={`text-sm mt-2 flex items-center font-medium ${trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-slate-400'}`}>
                        {trend === 'up' ? <TrendingUp size={16} className="mr-1" /> : trend === 'down' ? <TrendingDown size={16} className="mr-1" /> : null}
                        {subValue}
                    </p>
                )}
            </div>
            <div className="p-3 bg-slate-800/80 rounded-xl shadow-inner border border-slate-700/50">
                <Icon size={24} className={trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-blue-400'} />
            </div>
        </div>
    </div>
);

export const Dashboard = () => {
    const { t } = useTranslation();
    const [profile, setProfile] = useState<any>(null);
    const [bets, setBets] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedChannel, setSelectedChannel] = useState<string>('All');
    const [selectedMonth, setSelectedMonth] = useState<string>('All');
    const [channelProfiles, setChannelProfiles] = useState<any[]>([]);
    const [monthlyConfigs, setMonthlyConfigs] = useState<any[]>([]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Bankroll Profile (Global fallback)
                const { data: bData } = await supabase.from('bankroll_profiles').select('*').limit(1).single();
                if (bData) setProfile(bData);

                // Fetch Channel Bankrolls
                const { data: cbData } = await supabase.from('channel_bankrolls').select('*');
                if (cbData) setChannelProfiles(cbData);

                // Fetch Bets
                const { data: betsData } = await supabase.from('manual_bets').select('*').order('bet_date', { ascending: false });
                if (betsData) setBets(betsData);

                // Fetch Monthly Configs
                const { data: mcData } = await supabase.from('monthly_configs').select('*');
                if (mcData) setMonthlyConfigs(mcData);

            } catch (e) {
                console.error("Error fetching data:", e);
            } finally {
                setLoading(false);
            }
        };

        fetchData();

        // Subscribe to bet changes for realtime dashboard updates
        const channel = supabase.channel('dashboard_updates')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'manual_bets' }, () => {
                fetchData();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bankroll_profiles' }, () => {
                fetchData();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'channel_bankrolls' }, () => {
                fetchData();
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, []);

    if (loading) return <div className="p-8 text-center text-slate-400">Loading Dashboard...</div>;

    // Global Metrics (Always All)
    const globalProfit = bets.reduce((acc, bet) => acc + (bet.profit || 0), 0);
    const globalMyStaked = bets.filter(b => b.status !== 'pending').reduce((acc, bet) => acc + (bet.stake_amount || 0), 0);
    const globalTipsterProfit = bets.reduce((acc, bet) => acc + (bet.tipster_profit || 0), 0);
    const globalWon = bets.filter(b => b.status === 'won').length;
    const globalLost = bets.filter(b => b.status === 'lost').length;
    const globalTotal = globalWon + globalLost;
    const globalWinRate = globalTotal > 0 ? ((globalWon / globalTotal) * 100).toFixed(1) : '0.0';

    // Month Filtering
    const availableMonths = ['All', ...Array.from(new Set(bets.map(b => b.bet_date.slice(0, 7))))].sort((a, b) => b.localeCompare(a));

    // Filtering logic for the Channel specific section
    const channels = ['All', ...Array.from(new Set(bets.map(b => b.channel || 'Personal')))];
    const channelBets = selectedChannel === 'All' ? bets : bets.filter(b => (b.channel || 'Personal') === selectedChannel);

    const previousBets = selectedMonth === 'All' ? [] : channelBets.filter(b => b.bet_date.slice(0, 7) < selectedMonth);
    const filteredBets = selectedMonth === 'All' ? channelBets : channelBets.filter(b => b.bet_date.slice(0, 7) === selectedMonth);

    const channelMyProfit = filteredBets.reduce((acc, bet) => acc + (bet.profit || 0), 0);
    const channelMyStaked = filteredBets.filter(b => b.status !== 'pending').reduce((acc, bet) => acc + (bet.stake_amount || 0), 0);
    const channelTipsterProfit = filteredBets.reduce((acc, bet) => acc + (bet.tipster_profit || 0), 0);
    const channelTipsterStaked = filteredBets.filter(b => b.status !== 'pending').reduce((acc, bet) => acc + (bet.tipster_amount || 0), 0);

    const channelWon = filteredBets.filter(b => b.status === 'won').length;
    const channelLost = filteredBets.filter(b => b.status === 'lost').length;
    const channelTotal = channelWon + channelLost;
    const channelWinRate = channelTotal > 0 ? ((channelWon / channelTotal) * 100).toFixed(1) : '0.0';

    // Determine Bankrolls based on selection
    const activeChannelProfile = channelProfiles.find(cp => cp.channel_name === selectedChannel);

    // Global combines all channels if they exist, else fallbacks to global profile
    const globalStartBankroll = channelProfiles.length > 0
        ? channelProfiles.reduce((acc, cp) => acc + Number(cp.starting_bankroll), 0)
        : (profile?.starting_bankroll || 100);

    const globalCurrentBankroll = channelProfiles.length > 0
        ? channelProfiles.reduce((acc, cp) => acc + Number(cp.current_bankroll), 0)
        : (profile?.current_bankroll || 100);

    const channelStartBankrollBase = activeChannelProfile ? Number(activeChannelProfile.starting_bankroll) : (profile?.starting_bankroll || 100);
    const channelCurrentBankroll = activeChannelProfile ? Number(activeChannelProfile.current_bankroll) : (profile?.current_bankroll || 100);

    const startCapitalBase = selectedChannel === 'All' ? globalStartBankroll : channelStartBankrollBase;

    // For specific month, starting capital = profile starting + sum of ALL previous profits
    let startCapital = startCapitalBase + previousBets.reduce((acc, bet) => acc + (bet.profit || 0), 0);
    let startTipsterCapital = previousBets.reduce((acc, bet) => acc + (bet.tipster_profit || 0), 0);

    const baseTipsterBank = selectedChannel === 'Sport Apuestas Premium' ? 20000 : 0;

    if (selectedMonth !== 'All') {
        if (selectedChannel === 'All') {
            const mc = monthlyConfigs.find(m => m.month === selectedMonth);
            if (mc) {
                startCapital = Number(mc.starting_bankroll);
            }
        } else {
            // For specific channel, reset for the month to its configured start base
            startCapital = channelStartBankrollBase;
            startTipsterCapital = 0; // Tipster starts fresh from base
        }
    }

    const currentBankrollDisplay = selectedMonth === 'All' ? (selectedChannel === 'All' ? globalCurrentBankroll : channelCurrentBankroll) : (startCapital + channelMyProfit);

    const currentTipsterBankrollDisplay = baseTipsterBank + startTipsterCapital + channelTipsterProfit;

    // Growth Data for Chart
    let runningBank = startCapital;
    let runningTipsterProfit = startTipsterCapital;
    const chartData = [...filteredBets].reverse()
        .filter(b => b.status !== 'pending')
        .map((bet, index) => {
            runningBank += (bet.profit || 0);
            runningTipsterProfit += (bet.tipster_profit || 0);
            return {
                chartId: `bet-${index + 1}`,
                date: bet.bet_date.split('T')[0],
                rawDate: bet.bet_date,
                bankroll: runningBank,
                tipsterBankroll: runningTipsterProfit,
                profit: bet.profit,
                betStake: bet.stake_amount || 0,
                betProfit: bet.profit || 0,
                tipsterStake: bet.tipster_amount || 0,
                tipsterProfit: bet.tipster_profit || 0,
                selection: bet.selection,
                betNumber: index + 1
            };
        });

    // Inject initial point
    if (chartData.length > 0) {
        chartData.unshift({
            chartId: 'start-0',
            date: selectedMonth !== 'All' ? t('dashboard.startMonth', 'Inicio Mes') : t('dashboard.start', 'Inicio'),
            rawDate: '',
            bankroll: startCapital,
            tipsterBankroll: startTipsterCapital,
            profit: 0,
            betStake: 0,
            betProfit: 0,
            tipsterStake: 0,
            tipsterProfit: 0,
            selection: '',
            betNumber: 0
        });
    }

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-white mb-2">{t('dashboard.title')}</h1>
                    <p className="text-slate-400">{t('dashboard.subtitle')}</p>
                </div>
                <div className="flex flex-col md:flex-row items-center gap-4 w-full md:w-auto mt-4 md:mt-0">
                    <div className="bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        <span className="text-sm font-medium text-emerald-400">{t('dashboard.live')}</span>
                    </div>
                </div>
            </div>

            {/* Resumen Global (Todos los Canales) */}
            <div className="mb-4">
                <h2 className="text-xl font-bold text-white mb-4">🌍 Resumen Global (Todos los Canales)</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <StatCard
                        title={t('dashboard.currentBankroll', 'Mis Ganancias (Bank)')}
                        value={`${globalProfit >= 0 ? '+' : ''}${formatCurrency(globalProfit)}`}
                        subValue={`Total Bank: ${formatCurrency(currentBankrollDisplay)}`}
                        trend={globalProfit >= 0 ? "up" : "down"}
                        infoText="El dinero real que tú has ganado (o perdido) jugando en todos tus canales juntos."
                        icon={Wallet}
                    />
                    <StatCard
                        title="Ganancia General de Tipsters"
                        value={`${globalTipsterProfit >= 0 ? '+' : ''}${formatCurrency(globalTipsterProfit)}`}
                        subValue="Utilidad total generada por sus picks"
                        trend={globalTipsterProfit >= 0 ? "up" : "down"}
                        infoText="La ganancia neta o pura que los Tipsters han hecho en sus cuentas virtuales."
                        icon={TrendingUp}
                    />
                    <StatCard
                        title={t('dashboard.winRate', 'Win Rate Global')}
                        value={`${globalWinRate}%`}
                        subValue={`${globalWon} ganadas / ${globalLost} perdidas`}
                        infoText="El porcentaje de veces que ganamos en comparación a las veces que apostamos."
                        icon={Activity}
                    />
                    <StatCard
                        title="Turnover Global"
                        value={formatCurrency(globalMyStaked)}
                        subValue={`${globalWinRate}% Win Rate`}
                        infoText="Dinero total movido a nivel global de todos tus canales combinados."
                        icon={Activity}
                    />
                    <StatCard
                        title="Total de Apuestas Global"
                        value={globalTotal.toString()}
                        subValue={`${globalWon} ganadas / ${globalLost} perdidas`}
                        infoText="Cantidad total de apuestas a nivel global de tu Ledger."
                        icon={Activity}
                    />
                    <StatCard
                        title={t('dashboard.pendingBets', 'Apuestas Pendientes')}
                        value={bets.filter(b => b.status === 'pending').length.toString()}
                        subValue="En todos los canales"
                        infoText="Apuestas en proceso que aún no terminan."
                        icon={AlertCircle}
                    />
                </div>
            </div>

            {/* Análisis Específico de Canal */}
            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 border-b border-slate-700/50 pb-6">
                    <div>
                        <h2 className="text-xl font-bold text-white mb-1">📡 Rendimiento Detallado por Canal</h2>
                        <p className="text-sm text-slate-400">Analiza el rendimiento por Canal y Mes (Rollover Automático).</p>
                    </div>

                    <div className="flex flex-col md:flex-row items-center gap-3 w-full md:w-auto">
                        <select
                            value={selectedChannel}
                            onChange={(e) => setSelectedChannel(e.target.value)}
                            className="bg-slate-800/80 px-4 py-3 border border-blue-500/50 rounded-xl text-white focus:outline-none focus:border-blue-400 font-medium w-full md:w-48 appearance-none"
                        >
                            {channels.map(ch => (
                                <option key={ch} value={ch}>{ch === 'All' ? 'Todos los Canales' : ch}</option>
                            ))}
                        </select>
                        <select
                            value={selectedMonth}
                            onChange={(e) => setSelectedMonth(e.target.value)}
                            className="bg-slate-800/80 px-4 py-3 border border-emerald-500/50 rounded-xl text-white focus:outline-none focus:border-emerald-400 font-medium w-full md:w-40 appearance-none"
                        >
                            {availableMonths.map(m => {
                                if (m === 'All') return <option key={m} value={m}>Historico Total</option>;
                                return <option key={m} value={m}>{m}</option>;
                            })}
                        </select>
                    </div>
                </div>

                {selectedChannel === 'All' ? (
                    selectedMonth === 'All' ? (
                        <div className="py-8 text-center text-slate-400">
                            Selecciona un mes o un canal en los filtros para ver detalles específicos.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <StatCard
                                title={`Capital Inicial del Mes`}
                                value={formatCurrency(startCapital)}
                                infoText="Capital inicial configurado para este mes en Configuración."
                                icon={Wallet}
                            />
                            <StatCard
                                title={`Ganancia Mensual`}
                                value={`${channelMyProfit >= 0 ? '+' : ''}${formatCurrency(channelMyProfit)}`}
                                trend={channelMyProfit >= 0 ? "up" : "down"}
                                infoText="El total ganado durante este mes en todos los canales."
                                icon={TrendingUp}
                            />
                            <StatCard
                                title={`Banco Actual del Mes`}
                                value={formatCurrency(startCapital + channelMyProfit)}
                                infoText="Capital Inicial + Ganancia Mensual."
                                icon={Wallet}
                            />
                        </div>
                    )
                ) : (
                    <div className="space-y-8 mt-4">
                        <div>
                            <h3 className="text-lg font-bold text-blue-400 mb-4 flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-500"></div>Mi Gestión Real ({selectedChannel})</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
                                <StatCard
                                    title={`Capital Inicial ${selectedMonth !== 'All' ? 'del Mes' : ''}`}
                                    value={formatCurrency(startCapital)}
                                    infoText="Con cuánto dinero empezaste a jugar este periodo en este canal."
                                    icon={Wallet}
                                />
                                <StatCard
                                    title={`Ganancia Neta`}
                                    value={`${channelMyProfit >= 0 ? '+' : ''}${formatCurrency(channelMyProfit)}`}
                                    trend={channelMyProfit >= 0 ? "up" : "down"}
                                    infoText="El dinero que has ganado en este canal."
                                    icon={TrendingUp}
                                />
                                <StatCard
                                    title={`Banco Actual`}
                                    value={formatCurrency(currentBankrollDisplay)}
                                    infoText="Capital Inicial + Ganancia Neta."
                                    icon={Wallet}
                                />
                                <StatCard
                                    title={`Turnover / Win Rate`}
                                    value={formatCurrency(channelMyStaked)}
                                    subValue={`${channelWinRate}% Win Rate`}
                                    infoText="Dinero total movido y porcentaje de acierto en este canal."
                                    icon={Activity}
                                />
                                <StatCard
                                    title={`Total de Apuestas`}
                                    value={channelTotal.toString()}
                                    subValue={`${channelWon} ganadas / ${channelLost} perdidas`}
                                    infoText="Cantidad total de apuestas en tu gestión."
                                    icon={Activity}
                                />
                            </div>
                        </div>

                        <div className="pt-6 border-t border-slate-700/50">
                            <h3 className="text-lg font-bold text-emerald-400 mb-4 flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-emerald-500"></div>Rendimiento Tipster</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
                                <StatCard
                                    title={`Capital Inicial Tipster`}
                                    value={formatCurrency(baseTipsterBank + startTipsterCapital)}
                                    infoText="Banco inicial simulado del tipster."
                                    icon={Wallet}
                                />
                                <StatCard
                                    title={`Ganancia Neta Tipster`}
                                    value={`${channelTipsterProfit >= 0 ? '+' : ''}${formatCurrency(channelTipsterProfit)}`}
                                    trend={channelTipsterProfit >= 0 ? "up" : "down"}
                                    infoText="Utilidad de picks del tipster."
                                    icon={TrendingUp}
                                />
                                <StatCard
                                    title={`Banco Actual Tipster`}
                                    value={formatCurrency(currentTipsterBankrollDisplay)}
                                    infoText="Capital Inicial + Ganancia Neta del Tipster."
                                    icon={Wallet}
                                />
                                <StatCard
                                    title={`Turnover / Win Rate`}
                                    value={formatCurrency(channelTipsterStaked)}
                                    subValue={`${channelWinRate}% Win Rate`}
                                    infoText="Dinero total movido y porcentaje de acierto del tipster."
                                    icon={Activity}
                                />
                                <StatCard
                                    title={`Total de Apuestas`}
                                    value={channelTotal.toString()}
                                    subValue={`${channelWon} ganadas / ${channelLost} perdidas`}
                                    infoText="Cantidad total de apuestas realizadas en este periodo."
                                    icon={Activity}
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Main Chart Area */}
            <div className="flex flex-col gap-6">
                {/* Personal Bankroll Chart */}
                <div className="glass-card p-6 md:p-8 rounded-2xl border border-blue-500/30 shadow-[0_0_20px_rgba(59,130,246,0.05)]">
                    <div className="flex flex-col mb-8">
                        <h2 className="text-xl font-bold text-blue-400 mb-2">{t('dashboard.evolutionPersonal', 'Evolución de Mi Gestión Real')}</h2>
                        <p className="text-sm text-slate-400">Analiza cómo crece tu banco personal.</p>
                    </div>

                    <div className="h-[300px] w-full">
                        {chartData.length > 1 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="colorBankroll" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                    <XAxis
                                        dataKey="chartId"
                                        stroke="#94a3b8"
                                        tick={{ fill: '#94a3b8' }}
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(val) => {
                                            const idx = chartData.findIndex(d => d.chartId === val);
                                            if (idx < 0) return '';
                                            if (idx > 0 && chartData[idx].date === chartData[idx - 1].date) return ''; // Hide consecutive identical dates
                                            return chartData[idx].date;
                                        }}
                                    />
                                    <YAxis
                                        stroke="#94a3b8"
                                        tick={{ fill: '#94a3b8' }}
                                        tickLine={false}
                                        axisLine={false}
                                        domain={['auto', 'auto']}
                                        tickFormatter={(value) => `$${value}`}
                                    />
                                    <Legend
                                        verticalAlign="top"
                                        height={36}
                                        formatter={() => <span className="text-blue-400 font-medium">Mi Gestión (Banco Real)</span>}
                                    />
                                    <Tooltip
                                        content={({ active, payload, label }) => {
                                            if (active && payload && payload.length) {
                                                const data = payload[0].payload;
                                                if (!data.rawDate) {
                                                    return (
                                                        <div className="bg-slate-800 p-4 border border-blue-500/30 rounded-xl shadow-xl">
                                                            <p className="font-bold text-white mb-2">{data.date}</p>
                                                            <p className="text-slate-300 text-sm">Capital Inicial Mi Gestión: <span className="text-blue-400 font-bold">{formatCurrency(data.bankroll)}</span></p>
                                                            <p className="text-xs text-slate-500 mt-2 italic">Este es el punto de partida del mes seleccionado.</p>
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <div className="bg-slate-800 p-5 border border-blue-500/30 rounded-xl shadow-xl z-50 min-w-[280px]">
                                                        <div className="mb-3 border-b border-slate-700/50 pb-2">
                                                            <div className="flex items-center justify-between">
                                                                <p className="font-bold text-white text-lg">{data.date}</p>
                                                                {data.betNumber > 0 && <span className="bg-blue-500/20 text-blue-400 text-xs font-bold px-2 py-1 rounded-md">Apuesta #{data.betNumber}</span>}
                                                            </div>
                                                            {data.selection && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{data.selection}</p>}
                                                        </div>
                                                        <div className="bg-blue-500/10 p-3.5 rounded-xl border border-blue-500/20">
                                                            <div className="flex justify-between text-sm text-slate-300 gap-4 mb-1">
                                                                <span className="text-slate-400">Tú Invertiste:</span>
                                                                <span className="font-mono text-white">{formatCurrency(data.betStake)}</span>
                                                            </div>
                                                            <div className="flex justify-between text-sm text-slate-300 mt-1 gap-4">
                                                                <span className="text-slate-400">Tu Resultado:</span>
                                                                <span className={`font-mono font-bold ${data.betProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                                    {data.betProfit >= 0 ? '+' : ''}{formatCurrency(data.betProfit)}
                                                                </span>
                                                            </div>
                                                            <div className="flex justify-between text-sm text-white mt-3 pt-3 border-t border-blue-500/20 gap-4">
                                                                <span className="font-medium">Capital Disponible <span className="text-xs text-slate-400 block font-normal">(Tu Banco)</span></span>
                                                                <span className="font-mono font-bold text-blue-300 self-center">{formatCurrency(data.bankroll)}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            }
                                            return null;
                                        }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="bankroll"
                                        name="Mi Bankroll"
                                        stroke="#3b82f6"
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorBankroll)"
                                        dot={{ r: 4, strokeWidth: 2, fill: '#1e293b', stroke: '#3b82f6' }}
                                        activeDot={{ r: 6, strokeWidth: 0, fill: '#3b82f6' }}
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500 flex-col gap-4 text-center">
                                <Activity size={48} className="opacity-20" />
                                <p>{t('dashboard.resolveOne')}</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Tipster Bankroll Chart */}
                {selectedChannel !== 'All' && (
                    <div className="glass-card p-6 md:p-8 rounded-2xl border border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.05)]">
                        <div className="flex flex-col mb-8">
                            <h2 className="text-xl font-bold text-emerald-400 mb-2">{t('dashboard.evolutionTipster', 'Evolución del Tipster')}</h2>
                            <p className="text-sm text-slate-400">Analiza el rendimiento bruto acumulado del tipster.</p>
                        </div>

                        <div className="h-[300px] w-full">
                            {chartData.length > 1 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="colorTipster" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                        <XAxis
                                            dataKey="chartId"
                                            stroke="#94a3b8"
                                            tick={{ fill: '#94a3b8' }}
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(val) => {
                                                const idx = chartData.findIndex(d => d.chartId === val);
                                                if (idx < 0) return '';
                                                if (idx > 0 && chartData[idx].date === chartData[idx - 1].date) return ''; // Hide consecutive identical dates
                                                return chartData[idx].date;
                                            }}
                                        />
                                        <YAxis
                                            stroke="#94a3b8"
                                            tick={{ fill: '#94a3b8' }}
                                            tickLine={false}
                                            axisLine={false}
                                            domain={['auto', 'auto']}
                                            tickFormatter={(value) => `$${value}`}
                                        />
                                        <Legend
                                            verticalAlign="top"
                                            height={36}
                                            formatter={() => <span className="text-emerald-400 font-medium">Rendimiento Tipster</span>}
                                        />
                                        <Tooltip
                                            content={({ active, payload, label }) => {
                                                if (active && payload && payload.length) {
                                                    const data = payload[0].payload;
                                                    if (!data.rawDate) {
                                                        return (
                                                            <div className="bg-slate-800 p-4 border border-emerald-500/30 rounded-xl shadow-xl">
                                                                <p className="font-bold text-white mb-2">{data.date}</p>
                                                                <p className="text-emerald-300 text-sm">Capital Base Tipster: <span className="text-emerald-400 font-bold">{formatCurrency(data.tipsterBankroll)}</span></p>
                                                                <p className="text-xs text-slate-500 mt-2 italic">Este es el punto de partida del mes seleccionado.</p>
                                                            </div>
                                                        );
                                                    }
                                                    return (
                                                        <div className="bg-slate-800 p-5 border border-emerald-500/30 rounded-xl shadow-xl z-50 min-w-[280px]">
                                                            <div className="mb-3 border-b border-slate-700/50 pb-2">
                                                                <div className="flex items-center justify-between">
                                                                    <p className="font-bold text-white text-lg">{data.date}</p>
                                                                    {data.betNumber > 0 && <span className="bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2 py-1 rounded-md">Apuesta #{data.betNumber}</span>}
                                                                </div>
                                                                {data.selection && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{data.selection}</p>}
                                                            </div>
                                                            <div className="bg-emerald-500/10 p-3.5 rounded-xl border border-emerald-500/20">
                                                                <div className="flex justify-between text-sm text-slate-300 gap-4 mb-1">
                                                                    <span className="text-slate-400">Riesgo en este pick:</span>
                                                                    <span className="font-mono text-white">{formatCurrency(data.tipsterStake)}</span>
                                                                </div>
                                                                <div className="flex justify-between text-sm text-slate-300 mt-1 gap-4">
                                                                    <span className="text-slate-400">Resultado del pick:</span>
                                                                    <span className={`font-mono font-bold ${data.tipsterProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                                        {data.tipsterProfit >= 0 ? '+' : ''}{formatCurrency(data.tipsterProfit)}
                                                                    </span>
                                                                </div>
                                                                <div className="flex justify-between text-sm text-white mt-3 pt-3 border-t border-emerald-500/20 gap-4">
                                                                    <span className="font-medium">Acumulado Mes <span className="text-xs text-slate-400 block font-normal">(Ganancia Neta)</span></span>
                                                                    <span className="font-mono font-bold text-emerald-300 self-center">{formatCurrency(data.tipsterBankroll)}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                                return null;
                                            }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="tipsterBankroll"
                                            name="Ganancia Tipster"
                                            stroke="#10b981"
                                            strokeWidth={3}
                                            fillOpacity={1}
                                            fill="url(#colorTipster)"
                                            dot={{ r: 4, strokeWidth: 2, fill: '#1e293b', stroke: '#10b981' }}
                                            activeDot={{ r: 6, strokeWidth: 0, fill: '#10b981' }}
                                        />
                                    </AreaChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-slate-500 flex-col gap-4 text-center">
                                    <Activity size={48} className="opacity-20" />
                                    <p>{t('dashboard.resolveOne')}</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Recent Activity */}
            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <h2 className="text-xl font-bold text-white mb-6">{t('dashboard.recentActivity')} ({selectedChannel === 'All' ? 'Todos' : selectedChannel})</h2>
                {filteredBets.length === 0 ? (
                    <div className="text-center p-8 text-slate-500 bg-slate-800/20 rounded-xl border border-slate-700/30">
                        {t('dashboard.noBets', 'No hay apuestas registradas para este periodo.')}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* TIPSTER COLUMN */}
                        <div className="bg-emerald-500/5 p-4 rounded-xl border border-emerald-500/10">
                            <h3 className="text-lg font-bold text-emerald-400 mb-4 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Rendimiento Tipster
                            </h3>
                            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                                {filteredBets.map(bet => (
                                    <div key={`tipster-${bet.id}`} className="flex justify-between items-center p-4 bg-slate-800/40 rounded-xl hover:bg-slate-800/60 transition-colors border border-emerald-500/10">
                                        <div className="flex items-center gap-4">
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0
                                                ${bet.status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                                                    bet.status === 'lost' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'}`}>
                                                {bet.status === 'won' ? 'W' : bet.status === 'lost' ? 'L' : '?'}
                                            </div>
                                            <div className="max-w-[150px] md:max-w-[200px]">
                                                <p className="font-medium text-white truncate text-sm">{bet.selection}</p>
                                                <p className="text-xs text-slate-400">{bet.bet_date.split('T')[0]} • @{bet.odds}</p>
                                            </div>
                                        </div>
                                        <div className="text-right flex flex-col items-end justify-center">
                                            <p className="font-bold text-white text-sm">${bet.tipster_amount?.toFixed(2) || '0.00'}</p>
                                            <p className="text-xs text-slate-500">Riesgo Tipster</p>
                                            {bet.tipster_profit !== null && (
                                                <p className={`text-xs font-bold mt-1 ${bet.tipster_profit > 0 ? "text-emerald-400" : bet.tipster_profit < 0 ? "text-red-400" : "text-slate-400"}`}>
                                                    {bet.tipster_profit > 0 ? '+' : ''}${bet.tipster_profit.toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* PERSONAL COLUMN */}
                        <div className="bg-blue-500/5 p-4 rounded-xl border border-blue-500/10">
                            <h3 className="text-lg font-bold text-blue-400 mb-4 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-blue-500"></span> Mi Gestión Real
                            </h3>
                            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                                {filteredBets.map(bet => (
                                    <div key={`personal-${bet.id}`} className="flex justify-between items-center p-4 bg-slate-800/40 rounded-xl hover:bg-slate-800/60 transition-colors border border-blue-500/10">
                                        <div className="flex items-center gap-4">
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0
                                                ${bet.status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                                                    bet.status === 'lost' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'}`}>
                                                {bet.status === 'won' ? 'W' : bet.status === 'lost' ? 'L' : '?'}
                                            </div>
                                            <div className="max-w-[150px] md:max-w-[200px]">
                                                <p className="font-medium text-white truncate text-sm">{bet.selection}</p>
                                                <p className="text-xs text-slate-400">{bet.bet_date.split('T')[0]} • @{bet.odds}</p>
                                            </div>
                                        </div>
                                        <div className="text-right flex flex-col items-end justify-center">
                                            {bet.stake_amount === 0 ? (
                                                <>
                                                    <p className="font-bold text-blue-400 text-sm">Tracking</p>
                                                    <p className="text-xs text-slate-500">Sin Inversión</p>
                                                </>
                                            ) : (
                                                <>
                                                    <p className="font-bold text-white text-sm">${bet.stake_amount?.toFixed(2)}</p>
                                                    <p className="text-xs text-slate-500">Stake {bet.stake_norm}</p>
                                                    {bet.profit !== null && (
                                                        <p className={`text-xs font-bold mt-1 ${bet.profit > 0 ? "text-emerald-400" : bet.profit < 0 ? "text-red-400" : "text-slate-400"}`}>
                                                            {bet.profit > 0 ? '+' : ''}${bet.profit.toFixed(2)}
                                                        </p>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
