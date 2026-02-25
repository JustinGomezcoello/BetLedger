import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, AlertCircle, PlusCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const NewBet = () => {
    const { t } = useTranslation();
    const [formData, setFormData] = useState({
        bet_date: new Date().toISOString().split('T')[0],
        bet_type: 'single',
        category: 'Football',
        selection: '',
        description: '',
        odds: '',
        stake_norm: '5',
        channel: 'Sport Apuestas',
        tipster_amount: ''
    });

    // State for the second leg of a double bet
    const [leg2, setLeg2] = useState({
        selection: '',
        description: ''
    });

    const [tipsterScale, setTipsterScale] = useState('10');
    const [tipsterStakeInput, setTipsterStakeInput] = useState('');

    const [userProfile, setUserProfile] = useState<any>(null);

    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchProfile = async () => {
            const { data } = await supabase.from('bankroll_profiles').select('current_bankroll, stake10_percent').limit(1).single();
            if (data) {
                setUserProfile(data);
            }
        };
        fetchProfile();
    }, []);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.selection || !formData.odds || !formData.tipster_amount || !tipsterStakeInput || !tipsterScale) {
            setError('Por favor, completa todos los campos requeridos (incluyendo Inversión del Tipster).');
            return;
        }

        if (formData.bet_type === 'double' && !leg2.selection) {
            setError('Por favor, completa la selección de la Apuesta 2.');
            return;
        }

        setLoading(true);
        setError('');
        setSuccess(false);
        setSuccess(false);

        try {
            // Get active bankroll profile to calculate actual stake amount
            const { data: profileData, error: profileError } = await supabase
                .from('bankroll_profiles')
                .select('id, current_bankroll, stake10_percent')
                .limit(1)
                .single();

            if (profileError) throw profileError;

            // Calculate the specific amount for this stake
            const maxStakeAmount = profileData.current_bankroll * profileData.stake10_percent;
            const amount = (parseInt(formData.stake_norm) / 10) * maxStakeAmount;

            // Calculate Tipster Data
            const tAmount = parseFloat(formData.tipster_amount) || 0;

            // Calculate final fields based on bet type
            let finalSelection = formData.selection;
            let finalDescription = formData.description;
            // The odds field now represents the TOTAL odds for both single and double bets
            let finalOdds = parseFloat(formData.odds);

            if (formData.bet_type === 'double') {
                finalSelection = `${formData.selection} + ${leg2.selection}`;
                finalDescription = `${formData.description} | ${leg2.description}`;
                // Final odds are already provided in formData.odds
            }

            const { error: insertError } = await supabase
                .from('manual_bets')
                .insert([{
                    profile_id: profileData.id,
                    bet_date: new Date(formData.bet_date).toISOString(),
                    bet_type: formData.bet_type,
                    category: formData.category,
                    selection: finalSelection,
                    description: finalDescription,
                    odds: finalOdds,
                    stake_norm: parseInt(formData.stake_norm),
                    stake_amount: amount,
                    status: 'pending',
                    channel: formData.channel,
                    tipster_amount: tAmount > 0 ? tAmount : null,
                    tipster_profit: null
                }]);

            if (insertError) throw insertError;

            setSuccess(true);
            setFormData({
                ...formData,
                selection: '',
                description: '',
                odds: '',
                tipster_amount: ''
            });
            setTipsterStakeInput('');
            setLeg2({
                selection: '',
                description: ''
            });

        } catch (err: any) {
            console.error(err);
            setError(err.message || t('newBet.error', 'Error al guardar la apuesta.'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto">
            <div className="mb-8">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-blue-400 bg-clip-text text-transparent flex items-center gap-3">
                    <PlusCircle size={32} className="text-emerald-400" /> {t('newBet.title')}
                </h1>
                <p className="text-slate-400 mt-2">{t('newBet.subtitle')}</p>
            </div>

            {success && (
                <div className="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-xl flex items-center gap-3">
                    <AlertCircle size={20} />
                    {t('newBet.success')}
                </div>
            )}

            {error && (
                <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-center gap-3">
                    <AlertCircle size={20} />
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* LEFT: FORM */}
                <div className="glass-card p-6 md:p-8 rounded-2xl lg:col-span-2">
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">{t('newBet.channel', 'Canal de Origen')}</label>
                                <select
                                    name="channel"
                                    value={formData.channel}
                                    onChange={handleChange}
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-semibold text-blue-300"
                                >
                                    <option value="Sport Apuestas">Sport Apuestas</option>
                                    <option value="Sport Apuestas Premium">Sport Apuestas Premium</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">{t('newBet.date')}</label>
                                <input
                                    type="date"
                                    name="bet_date"
                                    value={formData.bet_date}
                                    onChange={handleChange}
                                    required
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">{t('newBet.category')}</label>
                                <input
                                    type="text"
                                    name="category"
                                    value={formData.category}
                                    onChange={handleChange}
                                    placeholder={t('newBet.catPlaceholder')}
                                    required
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">{t('newBet.type')}</label>
                                <select
                                    name="bet_type"
                                    value={formData.bet_type}
                                    onChange={handleChange}
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                >
                                    <option value="single">{t('newBet.single')}</option>
                                    <option value="double">{t('newBet.double')}</option>
                                </select>
                            </div>

                            <div className="space-y-2 md:col-span-2 mt-4 pt-4 border-t border-slate-700/50">
                                <h3 className="text-lg font-bold text-blue-400 mb-2">💰 Inversión del Tipster</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">Monto del Tipster (€/$)</label>
                                        <input
                                            type="number"
                                            name="tipster_amount"
                                            min="0"
                                            step="0.01"
                                            value={formData.tipster_amount}
                                            onChange={handleChange}
                                            placeholder="Ej. 1000"
                                            className="w-full bg-slate-900 border border-emerald-500/30 rounded-xl px-4 py-3 text-emerald-300 font-mono text-lg focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">Stake del Tipster</label>
                                        <input
                                            type="number"
                                            min="0"
                                            value={tipsterStakeInput}
                                            onChange={(e) => {
                                                setTipsterStakeInput(e.target.value);
                                                const val = parseFloat(e.target.value);
                                                const scale = parseFloat(tipsterScale);
                                                if (!isNaN(val) && !isNaN(scale) && scale > 0) {
                                                    let suggested = Math.round((val / scale) * 10);
                                                    if (suggested < 1) suggested = 1;
                                                    if (suggested > 10) suggested = 10;
                                                    setFormData({ ...formData, stake_norm: suggested.toString() });
                                                }
                                            }}
                                            placeholder="Ej. 10"
                                            className="w-full bg-slate-900 border border-blue-500/30 rounded-xl px-4 py-3 text-blue-300 font-mono text-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">Escala de su Stake</label>
                                        <input
                                            type="number"
                                            min="0"
                                            value={tipsterScale}
                                            onChange={(e) => {
                                                setTipsterScale(e.target.value);
                                                const val = parseFloat(tipsterStakeInput);
                                                const scale = parseFloat(e.target.value);
                                                if (!isNaN(val) && !isNaN(scale) && scale > 0) {
                                                    let suggested = Math.round((val / scale) * 10);
                                                    if (suggested < 1) suggested = 1;
                                                    if (suggested > 10) suggested = 10;
                                                    setFormData({ ...formData, stake_norm: suggested.toString() });
                                                }
                                            }}
                                            placeholder="Ej. 10 o 100"
                                            className="w-full bg-slate-900 border border-blue-500/30 rounded-xl px-4 py-3 text-blue-300 font-mono text-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4 md:col-span-2 mt-4">
                                <h3 className="text-lg font-bold text-blue-400 border-b border-slate-700 pb-2">
                                    {formData.bet_type === 'double' ? t('newBet.leg1', 'Apuesta 1 (Leg 1)') : t('newBet.details', 'Detalles de la Apuesta')}
                                </h3>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium text-slate-300">{t('newBet.selection')}</label>
                                        <input
                                            type="text"
                                            name="selection"
                                            value={formData.selection}
                                            onChange={handleChange}
                                            placeholder={t('newBet.selPlaceholder')}
                                            required
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">{t('newBet.description')}</label>
                                        <textarea
                                            name="description"
                                            value={formData.description}
                                            onChange={handleChange}
                                            placeholder={t('newBet.descPlaceholder')}
                                            rows={2}
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">{formData.bet_type === 'double' ? 'Cuota (Total Final de la Apuesta Doble)' : t('newBet.odds')}</label>
                                        <input
                                            type="number"
                                            name="odds"
                                            step="0.01"
                                            min="1.01"
                                            value={formData.odds}
                                            onChange={handleChange}
                                            placeholder={formData.bet_type === 'double' ? "Ej. 2.10" : "1.85"}
                                            required
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                        />
                                    </div>
                                </div>
                            </div>

                            {formData.bet_type === 'double' && (
                                <div className="space-y-4 md:col-span-2 mt-2">
                                    <h3 className="text-lg font-bold text-emerald-400 border-b border-slate-700 pb-2">
                                        {t('newBet.leg2', 'Apuesta 2 (Leg 2)')}
                                    </h3>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="space-y-2 md:col-span-2">
                                            <label className="text-sm font-medium text-slate-300">{t('newBet.selection')}</label>
                                            <input
                                                type="text"
                                                value={leg2.selection}
                                                onChange={(e) => setLeg2({ ...leg2, selection: e.target.value })}
                                                placeholder={t('newBet.selPlaceholder')}
                                                required
                                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
                                            />
                                        </div>

                                        <div className="space-y-2 md:col-span-2">
                                            <label className="text-sm font-medium text-slate-300">{t('newBet.description')}</label>
                                            <textarea
                                                value={leg2.description}
                                                onChange={(e) => setLeg2({ ...leg2, description: e.target.value })}
                                                placeholder={t('newBet.descPlaceholder')}
                                                rows={2}
                                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}

                        </div>

                        <div className="pt-6 flex justify-end">
                            <button
                                type="submit"
                                disabled={loading}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 px-8 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)] transition-all flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save size={20} />
                                {loading ? t('newBet.saving') : t('newBet.registerBtn')}
                            </button>
                        </div>
                    </form>
                </div>

                {/* RIGHT: TRANSFORMADOR & SUMMARY */}
                <div className="space-y-6">
                    {/* Mi Stake Summary */}
                    <div className="glass-card p-6 rounded-2xl border border-emerald-500/40 shadow-[0_0_40px_rgba(16,185,129,0.1)] relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                            <PlusCircle size={100} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-2 relative z-10">
                            📊 Mi Gestión Personal
                        </h3>
                        <p className="text-sm text-slate-400 mb-6 border-b border-slate-700/50 pb-4 relative z-10">
                            Aislando el tamaño del tipster a tu capital real.
                        </p>

                        <div className="space-y-6 relative z-10">
                            {/* Visual Slider Auto-Updated */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">Tu Stake Asignado</label>
                                <input
                                    type="range"
                                    name="stake_norm"
                                    min="1" max="10"
                                    value={formData.stake_norm}
                                    onChange={handleChange}
                                    className="w-full h-2 bg-slate-800 border border-slate-700 rounded-lg appearance-none cursor-pointer mt-4
                                           [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110
                                           [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:transition-all [&::-moz-range-thumb]:hover:scale-110"
                                />
                                <div className="text-center text-emerald-400 font-bold text-lg mt-2">{formData.stake_norm} / 10</div>
                            </div>

                            {userProfile && (
                                <div className="bg-slate-900/80 p-5 rounded-xl border border-slate-700/50 space-y-4">
                                    <div className="flex justify-between items-center text-sm">
                                        <span className="text-slate-400">💵 Inversión Real (Tuya):</span>
                                        <span className="text-white font-bold font-mono text-lg">
                                            ${(((parseFloat(formData.stake_norm) / 10) * (userProfile.current_bankroll * userProfile.stake10_percent))).toFixed(2)}
                                        </span>
                                    </div>

                                    {formData.odds && !isNaN(parseFloat(formData.odds)) && (
                                        <div className="flex justify-between items-center text-sm border-t border-slate-700/50 pt-4">
                                            <span className="text-slate-400">✅ Tu Ganancia Estimada:</span>
                                            <span className="text-emerald-400 font-bold font-mono text-2xl">
                                                +${((((parseFloat(formData.stake_norm) / 10) * (userProfile.current_bankroll * userProfile.stake10_percent))) * parseFloat(formData.odds) - (((parseFloat(formData.stake_norm) / 10) * (userProfile.current_bankroll * userProfile.stake10_percent)))).toFixed(2)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Tipster Expected Profit (For contrast) */}
                            {formData.odds && formData.tipster_amount && !isNaN(parseFloat(formData.odds)) && !isNaN(parseFloat(formData.tipster_amount)) && (
                                <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl space-y-2 mt-4">
                                    <div className="flex justify-between items-center text-xs">
                                        <span className="text-slate-400">Estimado que ganará Tipster:</span>
                                        <span className="text-blue-400 font-bold font-mono">
                                            + {((parseFloat(formData.tipster_amount) * parseFloat(formData.odds)) - parseFloat(formData.tipster_amount)).toLocaleString()}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
