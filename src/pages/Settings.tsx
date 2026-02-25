import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const Settings = () => {
    const { t } = useTranslation();
    const [profile, setProfile] = useState<any>(null);
    const [formData, setFormData] = useState({
        starting_bankroll: '',
        current_bankroll: '',
        stake10_percent: '0.05',
        use_compounding: true
    });

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const { data } = await supabase.from('bankroll_profiles').select('*').limit(1).single();
                if (data) {
                    setProfile(data);
                    setFormData({
                        starting_bankroll: data.starting_bankroll.toString(),
                        current_bankroll: data.current_bankroll.toString(),
                        stake10_percent: data.stake10_percent.toString(),
                        use_compounding: data.use_compounding
                    });
                }
            } catch (e) {
                console.error("Error fetching profile:", e);
            } finally {
                setLoading(false);
            }
        };
        fetchProfile();
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        setFormData({ ...formData, [e.target.name]: value });
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });

        try {
            if (!profile) throw new Error("No profile found.");

            const { error } = await supabase
                .from('bankroll_profiles')
                .update({
                    starting_bankroll: parseFloat(formData.starting_bankroll),
                    current_bankroll: parseFloat(formData.current_bankroll),
                    stake10_percent: parseFloat(formData.stake10_percent),
                    use_compounding: formData.use_compounding
                })
                .eq('id', profile.id);

            if (error) throw error;

            setMessage({ type: 'success', text: t('settings.success') });
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message || t('settings.error') });
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
                                onChange={handleChange as any}
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
