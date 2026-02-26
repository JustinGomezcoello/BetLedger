import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { CheckCircle2, XCircle, Clock, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const BetsList = () => {
    const { t } = useTranslation();
    const [bets, setBets] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchBets = async () => {
        try {
            const { data } = await supabase
                .from('manual_bets')
                .select('*')
                .order('bet_date', { ascending: false });

            if (data) setBets(data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchBets();
    }, []);

    const handleResolveBet = async (bet: any, outcome: 'won' | 'lost') => {
        const confirmMsg = outcome === 'won' ? t('betsList.confirmWin') : t('betsList.confirmLoss');
        if (!confirm(confirmMsg)) return;

        try {
            // 1. Calculate Profit
            let profit = 0;
            let tipsterProfit = null;
            if (outcome === 'won') {
                profit = (bet.stake_amount * bet.odds) - bet.stake_amount;
                if (bet.tipster_amount) {
                    tipsterProfit = (bet.tipster_amount * bet.odds) - bet.tipster_amount;
                }
            } else {
                profit = -bet.stake_amount;
                if (bet.tipster_amount) {
                    tipsterProfit = -bet.tipster_amount;
                }
            }

            // 2. Update Bet
            const { error: updateError } = await supabase
                .from('manual_bets')
                .update({ status: outcome, profit: profit, tipster_profit: tipsterProfit })
                .eq('id', bet.id);

            if (updateError) throw updateError;

            // 3. Update Bankroll Profile (Global)
            // Fetch current bankroll
            const { data: profile } = await supabase.from('bankroll_profiles').select('id, current_bankroll').eq('id', bet.profile_id).single();

            if (profile) {
                const newBankroll = Number(profile.current_bankroll) + profit;
                await supabase.from('bankroll_profiles').update({ current_bankroll: newBankroll }).eq('id', profile.id);
            }

            // 4. Update Channel Bankroll
            const channelName = bet.channel || 'Personal';
            const { data: channelProfile } = await supabase.from('channel_bankrolls').select('id, current_bankroll').eq('profile_id', bet.profile_id).eq('channel_name', channelName).single();

            if (channelProfile) {
                const newChannelBankroll = Number(channelProfile.current_bankroll) + profit;
                await supabase.from('channel_bankrolls').update({ current_bankroll: newChannelBankroll }).eq('id', channelProfile.id);
            }

            // Refresh list
            fetchBets();

        } catch (error) {
            console.error("Error resolving bet:", error);
            alert(t('betsList.errResolve'));
        }
    };

    const handleDelete = async (id: string, status: string) => {
        if (status !== 'pending') {
            alert(t('betsList.errDel'));
            return;
        }
        if (!confirm(t('betsList.confirmDel'))) return;

        await supabase.from('manual_bets').delete().eq('id', id);
        fetchBets();
    };

    if (loading) return <div className="p-8 text-slate-400">{t('betsList.loading')}</div>;

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto">
            <div className="mb-8">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
                    {t('betsList.title')}
                </h1>
                <p className="text-slate-400 mt-2">{t('betsList.subtitle')}</p>
            </div>

            <div className="glass-card rounded-2xl border border-slate-700/50 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-800/80 border-b border-slate-700 text-slate-300 text-sm whitespace-nowrap">
                                <th className="p-4 font-medium">{t('betsList.date')}</th>
                                <th className="p-4 font-medium">{t('betsList.category')}</th>
                                <th className="p-4 font-medium min-w-[150px]">{t('betsList.selection')}</th>
                                <th className="p-4 font-medium min-w-[150px]">{t('betsList.description')}</th>
                                <th className="p-4 font-medium">{t('betsList.odds')}</th>
                                <th className="p-4 font-medium">{t('betsList.stake')}</th>
                                <th className="p-4 font-medium">{t('betsList.result')}</th>
                                <th className="p-4 font-medium text-right min-w-[120px]">{t('betsList.actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bets.map((bet) => (
                                <tr key={bet.id} className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors">
                                    <td className="p-4 text-slate-300 whitespace-nowrap">
                                        {bet.bet_date.split('T')[0]}
                                    </td>
                                    <td className="p-4 text-slate-400 text-sm whitespace-nowrap">
                                        <div className="font-semibold text-blue-300">{bet.channel || 'Personal'}</div>
                                        {bet.category} <span className="text-xs text-slate-500 uppercase ml-1">({bet.bet_type})</span>
                                    </td>
                                    <td className="p-4 font-medium text-white max-w-[200px] truncate" title={bet.selection}>
                                        {bet.selection}
                                    </td>
                                    <td className="p-4 text-slate-400 text-sm max-w-[200px] truncate" title={bet.description}>
                                        {bet.description || '-'}
                                    </td>
                                    <td className="p-4 font-bold text-blue-400">
                                        @{bet.odds}
                                    </td>
                                    <td className="p-4 whitespace-nowrap">
                                        <div className="font-medium text-white">${bet.stake_amount?.toFixed(2)}</div>
                                        <div className="text-xs text-slate-500">{bet.stake_norm}/10 {t('betsList.units')}</div>
                                        {bet.tipster_amount && (
                                            <div className="text-xs text-blue-400 mt-1" title="Tipster Amount">Tipster: {bet.tipster_amount}</div>
                                        )}
                                    </td>
                                    <td className="p-4 whitespace-nowrap">
                                        {bet.status === 'won' && <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20"><CheckCircle2 size={14} /> {t('betsList.won')}</span>}
                                        {bet.status === 'lost' && <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 text-xs font-medium border border-red-500/20"><XCircle size={14} /> {t('betsList.lost')}</span>}
                                        {bet.status === 'pending' && <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-400 text-xs font-medium border border-blue-500/20"><Clock size={14} /> {t('betsList.pending')}</span>}
                                    </td>
                                    <td className="p-4 text-right">
                                        {bet.status === 'pending' ? (
                                            <div className="flex justify-end gap-2 text-white">
                                                <button
                                                    onClick={() => handleResolveBet(bet, 'won')}
                                                    className="bg-emerald-500/20 hover:bg-emerald-500 hover:text-white text-emerald-400 px-3 py-1.5 rounded-lg transition-colors border border-emerald-500/30 text-sm font-medium"
                                                >
                                                    {t('betsList.winBtn')}
                                                </button>
                                                <button
                                                    onClick={() => handleResolveBet(bet, 'lost')}
                                                    className="bg-red-500/20 hover:bg-red-500 hover:text-white text-red-400 px-3 py-1.5 rounded-lg transition-colors border border-red-500/30 text-sm font-medium"
                                                >
                                                    {t('betsList.lossBtn')}
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(bet.id, bet.status)}
                                                    className="p-1.5 hover:text-red-400 text-slate-500 transition-colors"
                                                    title={t('betsList.delBtn')}
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                            </div>
                                        ) : (
                                            <span className="font-bold text-[15px] block">
                                                {bet.profit >= 0 ? (
                                                    <span className="text-emerald-400">+${(bet.profit).toFixed(2)}</span>
                                                ) : (
                                                    <span className="text-red-400">-${Math.abs(bet.profit).toFixed(2)}</span>
                                                )}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}

                            {bets.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="p-8 text-center text-slate-500">
                                        {t('betsList.noHistory')}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
