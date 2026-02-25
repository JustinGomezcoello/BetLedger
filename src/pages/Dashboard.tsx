import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Wallet, TrendingUp, TrendingDown, Activity, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from 'react-i18next';

const StatCard = ({ title, value, subValue, trend, icon: Icon }: any) => (
    <div className="glass-card p-6 rounded-2xl border border-slate-700/50 relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex justify-between items-start relative z-10">
            <div>
                <p className="text-slate-400 text-sm font-medium">{title}</p>
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

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Bankroll Profile
                const { data: bData } = await supabase.from('bankroll_profiles').select('*').limit(1).single();
                if (bData) setProfile(bData);

                // Fetch Bets
                const { data: betsData } = await supabase.from('manual_bets').select('*').order('bet_date', { ascending: false });
                if (betsData) setBets(betsData);

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
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, []);

    if (loading) return <div className="p-8 text-center text-slate-400">Loading Dashboard...</div>;

    // Global Metrics (Always All)
    const globalProfit = bets.reduce((acc, bet) => acc + (bet.profit || 0), 0);
    const globalTipsterProfit = bets.reduce((acc, bet) => acc + (bet.tipster_profit || 0), 0);
    const globalWon = bets.filter(b => b.status === 'won').length;
    const globalLost = bets.filter(b => b.status === 'lost').length;
    const globalTotal = globalWon + globalLost;
    const globalWinRate = globalTotal > 0 ? ((globalWon / globalTotal) * 100).toFixed(1) : '0.0';

    // Filtering logic for the Channel specific section
    const channels = ['All', ...Array.from(new Set(bets.map(b => b.channel || 'Personal')))];
    const filteredBets = selectedChannel === 'All' ? bets : bets.filter(b => (b.channel || 'Personal') === selectedChannel);

    const channelMyProfit = filteredBets.reduce((acc, bet) => acc + (bet.profit || 0), 0);
    const channelTipsterProfit = filteredBets.reduce((acc, bet) => acc + (bet.tipster_profit || 0), 0);
    const channelWon = filteredBets.filter(b => b.status === 'won').length;
    const channelLost = filteredBets.filter(b => b.status === 'lost').length;
    const channelTotal = channelWon + channelLost;
    const channelWinRate = channelTotal > 0 ? ((channelWon / channelTotal) * 100).toFixed(1) : '0.0';

    const startCapital = profile?.starting_bankroll || 100;
    const currentBankroll = profile?.current_bankroll || 100;

    // Growth Data for Chart
    let runningBank = startCapital;
    const chartData = [...filteredBets].reverse()
        .filter(b => b.status !== 'pending')
        .map(bet => {
            runningBank += (bet.profit || 0);
            return {
                date: bet.bet_date.split('T')[0],
                bankroll: runningBank,
                profit: bet.profit
            };
        });

    // Inject initial point
    if (chartData.length > 0) {
        chartData.unshift({ date: t('dashboard.start'), bankroll: startCapital, profit: 0 });
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    <StatCard
                        title={t('dashboard.currentBankroll', 'Mis Ganancias (Bank)')}
                        value={`$${globalProfit >= 0 ? '+' : ''}${globalProfit.toFixed(2)}`}
                        subValue={`Total Bank: $${currentBankroll.toFixed(2)}`}
                        trend={globalProfit >= 0 ? "up" : "down"}
                        icon={Wallet}
                    />
                    <StatCard
                        title="Ganancia General de Tipsters"
                        value={`$${globalTipsterProfit >= 0 ? '+' : ''}${globalTipsterProfit.toFixed(2)}`}
                        subValue="Suma total de apuestas"
                        trend={globalTipsterProfit >= 0 ? "up" : "down"}
                        icon={TrendingUp}
                    />
                    <StatCard
                        title={t('dashboard.winRate', 'Win Rate Global')}
                        value={`${globalWinRate}%`}
                        subValue={`${globalWon} ganadas / ${globalLost} perdidas`}
                        icon={Activity}
                    />
                    <StatCard
                        title={t('dashboard.pendingBets', 'Apuestas Pendientes')}
                        value={bets.filter(b => b.status === 'pending').length.toString()}
                        subValue="En todos los canales"
                        icon={AlertCircle}
                    />
                </div>
            </div>

            {/* Análisis Específico de Canal */}
            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4 border-b border-slate-700/50 pb-6">
                    <div>
                        <h2 className="text-xl font-bold text-white mb-1">📡 Rendimiento Detallado por Canal</h2>
                        <p className="text-sm text-slate-400">Aisla las estadísticas para un Tipster o Canal específico.</p>
                    </div>

                    <select
                        value={selectedChannel}
                        onChange={(e) => setSelectedChannel(e.target.value)}
                        className="bg-slate-800/80 px-4 py-3 border border-blue-500/50 rounded-xl text-white focus:outline-none focus:border-blue-400 font-medium w-full md:w-auto"
                    >
                        {channels.map(ch => (
                            <option key={ch} value={ch}>{ch === 'All' ? '-- Selecciona un Canal --' : ch}</option>
                        ))}
                    </select>
                </div>

                {selectedChannel === 'All' ? (
                    <div className="py-8 text-center text-slate-400">
                        Selecciona un canal en el menú de arriba para ver su rendimiento individual.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <StatCard
                            title={`Mis Ganancias (${selectedChannel})`}
                            value={`$${channelMyProfit >= 0 ? '+' : ''}${channelMyProfit.toFixed(2)}`}
                            subValue="Dinero generado en mi Bank"
                            trend={channelMyProfit >= 0 ? "up" : "down"}
                            icon={Wallet}
                        />
                        <StatCard
                            title={`Ganancia Tipster (${selectedChannel})`}
                            value={`$${channelTipsterProfit >= 0 ? '+' : ''}${channelTipsterProfit.toFixed(2)}`}
                            subValue="Calculado según su inversión"
                            trend={channelTipsterProfit >= 0 ? "up" : "down"}
                            icon={TrendingUp}
                        />
                        <StatCard
                            title={`Win Rate (${selectedChannel})`}
                            value={`${channelWinRate}%`}
                            subValue={`${channelWon} ganadas / ${channelLost} perdidas`}
                            icon={Activity}
                        />
                    </div>
                )}
            </div>

            {/* Main Chart Area */}
            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-xl font-bold text-white">{t('dashboard.evolution')}</h2>
                </div>

                <div className="h-[400px] w-full">
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
                                <XAxis dataKey="date" stroke="#94a3b8" tick={{ fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                                <YAxis
                                    stroke="#94a3b8"
                                    tick={{ fill: '#94a3b8' }}
                                    tickLine={false}
                                    axisLine={false}
                                    domain={['auto', 'auto']}
                                    tickFormatter={(value) => `$${value}`}
                                />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '12px' }}
                                    itemStyle={{ color: '#e2e8f0' }}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="bankroll"
                                    stroke="#3b82f6"
                                    strokeWidth={3}
                                    fillOpacity={1}
                                    fill="url(#colorBankroll)"
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

            {/* Recent Activity */}
            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <h2 className="text-xl font-bold text-white mb-6">{t('dashboard.recentActivity')} ({selectedChannel === 'All' ? 'Todos' : selectedChannel})</h2>
                <div className="space-y-4">
                    {filteredBets.slice(0, 5).map(bet => (
                        <div key={bet.id} className="flex justify-between items-center p-4 bg-slate-800/30 rounded-xl hover:bg-slate-800/50 transition-colors border border-slate-700/30">
                            <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg
                  ${bet.status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                                        bet.status === 'lost' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                    {bet.status === 'won' ? 'W' : bet.status === 'lost' ? 'L' : '?'}
                                </div>
                                <div>
                                    <p className="font-medium text-white line-clamp-1">{bet.selection}</p>
                                    <p className="text-sm text-slate-400">{bet.category} • @{bet.odds} • <span className="text-blue-400">{bet.channel || 'Personal'}</span></p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="font-bold text-white">${bet.stake_amount?.toFixed(2)}</p>
                                <p className="text-sm text-slate-400">{t('dashboard.stake')} {bet.stake_norm}/10</p>
                            </div>
                        </div>
                    ))}
                    {bets.length === 0 && (
                        <div className="text-center p-6 text-slate-500">{t('dashboard.noBets')}</div>
                    )}
                </div>
            </div>
        </div>
    );
};
