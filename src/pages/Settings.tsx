import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    adjustBankroll,
    errorMessage,
    updateBankrollSettings,
    updateChannelSettings,
    upsertMonthlyConfig,
} from '../lib/ledger';
import type { BankrollProfile, ChannelBankroll, MonthlyConfig } from '../lib/ledger';

export const Settings = () => {
    const { t } = useTranslation();
    const [profile, setProfile] = useState<BankrollProfile | null>(null);
    const [formData, setFormData] = useState({
        starting_bankroll: '',
        current_bankroll: '',
        stake10_percent: '0.05',
        use_compounding: true
    });
    const [channels, setChannels] = useState<ChannelBankroll[]>([]);
    const [persistedChannels, setPersistedChannels] = useState<ChannelBankroll[]>([]);

    const [monthlyConfigs, setMonthlyConfigs] = useState<MonthlyConfig[]>([]);
    const [selectedMonth, setSelectedMonth] = useState<string>(new Date().toISOString().slice(0, 7));
    const [monthBankroll, setMonthBankroll] = useState<string>('');

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const { data } = await supabase.from('bankroll_profiles').select('*').limit(1).single();
                if (data) {
                    setProfile(data as BankrollProfile);
                    setFormData({
                        starting_bankroll: data.starting_bankroll.toString(),
                        current_bankroll: data.current_bankroll.toString(),
                        stake10_percent: data.stake10_percent.toString(),
                        use_compounding: data.use_compounding
                    });
                }
                const { data: cbData } = await supabase.from('channel_bankrolls').select('*').order('channel_name');
                if (cbData) {
                    setChannels(cbData as ChannelBankroll[]);
                    setPersistedChannels((cbData as ChannelBankroll[]).map((channel) => ({ ...channel })));
                }
                
                const { data: mcData } = await supabase.from('monthly_configs').select('*').order('month', { ascending: false });
                if (mcData) {
                    const configs = mcData as MonthlyConfig[];
                    setMonthlyConfigs(configs);
                    const currentMonthData = configs.find(m => m.month === new Date().toISOString().slice(0, 7));
                    if (currentMonthData) {
                        setMonthBankroll(currentMonthData.starting_bankroll.toString());
                    }
                }
            } catch (e) {
                console.error("Error fetching profile:", e);
            } finally {
                setLoading(false);
            }
        };
        fetchProfile();
    }, []);

    useEffect(() => {
        const config = monthlyConfigs.find(m => m.month === selectedMonth);
        if (config) {
            setMonthBankroll(config.starting_bankroll.toString());
        } else {
            setMonthBankroll('');
        }
    }, [selectedMonth, monthlyConfigs]);

    const handleChannelChange = (e: React.ChangeEvent<HTMLInputElement>, id: string) => {
        const { name, value } = e.target;
        setChannels(channels.map(ch => ch.id === id ? { ...ch, [name]: value } : ch));
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        setFormData({ ...formData, [e.target.name]: value });
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });

        try {
            if (!profile) throw new Error("No profile found.");

            await updateBankrollSettings(
                profile.id,
                parseFloat(formData.starting_bankroll),
                parseFloat(formData.stake10_percent),
                formData.use_compounding,
            );

            const requestedCurrent = parseFloat(formData.current_bankroll);
            if (requestedCurrent !== Number(profile.current_bankroll)) {
                await adjustBankroll(profile.id, null, requestedCurrent, 'Ajuste manual desde Configuración');
            }

            for (const ch of channels) {
                await updateChannelSettings(
                    ch.id,
                    Number(ch.starting_bankroll),
                    ch.max_stake_norm ?? (ch.channel_name.toLowerCase().includes('premium') ? 15 : Number(ch.stake_scale)),
                );
                const original = persistedChannels.find((candidate) => candidate.id === ch.id);
                if (original && Number(ch.current_bankroll) !== Number(original.current_bankroll)) {
                    await adjustBankroll(profile.id, ch.channel_name, Number(ch.current_bankroll), 'Ajuste manual desde Configuración');
                }
            }

            if (selectedMonth && monthBankroll) {
                await upsertMonthlyConfig(profile.id, selectedMonth, parseFloat(monthBankroll));
            }

            setMessage({ type: 'success', text: t('settings.success') });
            setProfile({
                ...profile,
                starting_bankroll: parseFloat(formData.starting_bankroll),
                current_bankroll: requestedCurrent,
                stake10_percent: parseFloat(formData.stake10_percent),
                use_compounding: formData.use_compounding,
            });
            setPersistedChannels(channels.map((channel) => ({ ...channel })));
        } catch (err: unknown) {
            setMessage({ type: 'error', text: errorMessage(err, t('settings.error')) });
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-8 text-slate-400">{t('settings.loading')}</div>;

    return (
        <div className="p-4 md:p-8 max-w-4xl">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-2">{t('settings.title')}</h1>
                <p className="text-slate-400">{t('settings.subtitle')}</p>
            </div>

            {message.text && (
                <div className={`mb-6 p-4 rounded-xl flex items-center gap-3 border ${message.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/10 border-red-500/20 text-red-400'
                    }`}>
                    <AlertCircle size={20} />
                    {message.text}
                </div>
            )}

            <div className="glass-card p-6 md:p-8 rounded-2xl border border-slate-700/50">
                <div className="flex items-center gap-3 border-b border-slate-700/50 pb-6 mb-6">
                    <div className="p-3 bg-blue-500/20 rounded-xl">
                        <RefreshCw className="text-blue-400" size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white">{t('settings.configTitle')}</h2>
                        <p className="text-sm text-slate-400">{t('settings.configSub')}</p>
                    </div>
                </div>

                <form onSubmit={handleSave} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* Start Bankroll */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">{t('settings.startBank')}</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                name="starting_bankroll"
                                value={formData.starting_bankroll}
                                onChange={handleChange}
                                required
                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                            />
                            <p className="text-xs text-slate-500">{t('settings.startDesc')}</p>
                        </div>

                        {/* Current Bankroll */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">{t('settings.currentBank')}</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                name="current_bankroll"
                                value={formData.current_bankroll}
                                onChange={handleChange}
                                required
                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                            />
                            <p className="text-xs text-slate-500">{t('settings.currentDesc')}</p>
                        </div>

                        {/* Stake % */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">{t('settings.stakeLimit')}</label>
                            <select
                                name="stake10_percent"
                                value={formData.stake10_percent}
                                onChange={handleChange}
                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                            >
                                <option value="0.01">{t('settings.stake1')}</option>
                                <option value="0.025">{t('settings.stake2')}</option>
                                <option value="0.05">{t('settings.stake5')}</option>
                                <option value="0.10">{t('settings.stake10')}</option>
                                <option value="0.25">{t('settings.stake25')}</option>
                            </select>
                            <p className="text-xs text-slate-500">{t('settings.stakeDesc')}</p>
                        </div>

                        {/* Checkbox */}
                        <div className="space-y-2 md:col-span-2 flex items-center gap-3">
                            <input
                                type="checkbox"
                                id="use_compounding"
                                name="use_compounding"
                                checked={formData.use_compounding}
                                onChange={handleChange}
                                className="w-5 h-5 rounded border-slate-600 text-blue-500 focus:ring-blue-500 bg-slate-800"
                            />
                            <label htmlFor="use_compounding" className="text-sm font-medium text-slate-300">
                                {t('settings.compounding')}
                                <span className="block text-xs text-slate-500 mt-0.5 font-normal">{t('settings.compDesc')}</span>
                            </label>
                        </div>
                    </div>

                    {channels.length > 0 && (
                        <div className="mt-8 pt-8 border-t border-slate-700/50 space-y-6">
                            <h3 className="text-lg font-bold text-white mb-4">Configuración Mensual (Mi Capital)</h3>
                            <div className="bg-slate-800/30 p-5 rounded-xl border border-slate-700/50 space-y-4 max-w-md mb-8">
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-400">Mes a configurar</label>
                                    <input
                                        type="month"
                                        value={selectedMonth}
                                        onChange={(e) => setSelectedMonth(e.target.value)}
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-400">Capital Inicial del Mes</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        placeholder="Ej: 500.00"
                                        value={monthBankroll}
                                        onChange={(e) => setMonthBankroll(e.target.value)}
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                                    />
                                    <p className="text-xs text-slate-500">Este valor se usará en el Dashboard para calcular tu rendimiento exacto de este mes.</p>
                                </div>
                            </div>
                            
                            <h3 className="text-lg font-bold text-white mb-4 mt-8 pt-6 border-t border-slate-700/50">Capital por Canales (Tipsters)</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {channels.map(ch => (
                                    <div key={ch.id} className="bg-slate-800/30 p-5 rounded-xl border border-slate-700/50 space-y-4">
                                        <h4 className="font-semibold text-blue-400">{ch.channel_name}</h4>
                                        <div className="space-y-2">
                                            <label className="text-xs font-medium text-slate-400">Bank Inicial (Ideal para nuevo mes)</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                min="0"
                                                name="starting_bankroll"
                                                value={ch.starting_bankroll}
                                                onChange={(e) => handleChannelChange(e, ch.id)}
                                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs font-medium text-slate-400">Bank Actual</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                min="0"
                                                name="current_bankroll"
                                                value={ch.current_bankroll}
                                                onChange={(e) => handleChannelChange(e, ch.id)}
                                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="mt-8 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm text-slate-300">
                        <h3 className="font-semibold text-emerald-300">Credenciales protegidas</h3>
                        <p className="mt-2 leading-6 text-slate-400">
                            BetLedger no almacena ni muestra contraseñas de casas de apuestas. Usa un gestor de contraseñas independiente y rota cualquier credencial que haya estado previamente dentro del código.
                        </p>
                    </div>

                    <div className="pt-6 flex justify-end">
                        <button
                            type="submit"
                            disabled={saving}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 px-8 rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.2)] hover:shadow-[0_0_25px_rgba(59,130,246,0.4)] transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            <Save size={20} />
                            {saving ? t('settings.saving') : t('settings.saveBtn')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
