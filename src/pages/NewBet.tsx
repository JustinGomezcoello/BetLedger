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
    const [isTracking, setIsTracking] = useState(false);

    const [userProfile, setUserProfile] = useState<any>(null);
    const [channelProfiles, setChannelProfiles] = useState<any[]>([]);

    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchProfile = async () => {
            const { data } = await supabase.from('bankroll_profiles').select('id, starting_bankroll, current_bankroll, stake10_percent').limit(1).single();
            if (data) {
                setUserProfile(data);
            }
            const { data: cbData } = await supabase.from('channel_bankrolls').select('*');
            if (cbData) {
                setChannelProfiles(cbData);
            }
        };
        fetchProfile();
    }, []);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData({ ...formData, [name]: value });

        // Auto-adjust scale based on channel
        if (name === 'channel') {
            if (value === 'Sport Apuestas Premium') {
                setTipsterScale('');
                setTipsterStakeInput('');
                setFormData(prev => ({ ...prev, channel: value, tipster_amount: '', stake_norm: '11' }));
            } else {
                setTipsterScale('10');
                setFormData(prev => ({
                    ...prev,
                    channel: value,
                    stake_norm: parseInt(prev.stake_norm) > 10 ? '5' : prev.stake_norm
                }));
            }
            return;
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Tipster Amount is only logically required for Standard 'Sport Apuestas' as Premium often omits it.
        const isPremium = formData.channel === 'Sport Apuestas Premium';

        if (!formData.selection || !formData.odds) {
            setError('Por favor, completa los campos base (selección, cuota).');
            return;
        }

        if (!isPremium && (!formData.tipster_amount || !tipsterStakeInput || !tipsterScale)) {
            setError('Para el canal Sport Apuestas normal, debes llenar el monto, stake y escala del Tipster.');
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
                .select('id, starting_bankroll, current_bankroll, stake10_percent')
                .limit(1)
                .single();

            if (profileError) throw profileError;

            // Fetch channel bankroll
            const { data: cbData } = await supabase
                .from('channel_bankrolls')
                .select('starting_bankroll')
                .eq('profile_id', profileData.id)
                .eq('channel_name', formData.channel)
                .single();

            const activeBankroll = cbData ? cbData.starting_bankroll : profileData.starting_bankroll;
            const maxStakeScale = formData.channel === 'Sport Apuestas Premium' ? 11 : 10;

            // Calculate the specific amount for this stake
            let maxStakeAmount = activeBankroll * profileData.stake10_percent;
            let amount = (parseInt(formData.stake_norm) / maxStakeScale) * maxStakeAmount;

            let finalStakeNorm = parseInt(formData.stake_norm);

            // If tracking mode, user invests 0
            if (isTracking) {
                amount = 0;
                finalStakeNorm = 0;
            }

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
                    stake_norm: finalStakeNorm,
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
            setIsTracking(false);
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

                            <div className="space-y-4 md:col-span-2 mt-4 pt-4 border-t border-slate-700/50">
                                <label className="flex items-center gap-3 bg-blue-500/10 p-4 rounded-xl border border-blue-500/20 cursor-pointer hover:bg-blue-500/20 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={isTracking}
                                        onChange={(e) => setIsTracking(e.target.checked)}
                                        className="w-5 h-5 rounded border-slate-600 text-blue-500 focus:ring-blue-500 bg-slate-800"
                                    />
                                    <div>
                                        <p className="font-bold text-blue-400">Modo Tracking (No aposté dinero real)</p>
                                        <p className="text-xs text-blue-300/70">Ideal para registrar apuestas pasadas del tipster sin afectar tu bankroll personal.</p>
                                    </div>
                                </label>
                            </div>

                            <div className="space-y-2 md:col-span-2 mt-4 pt-4 border-t border-slate-700/50">
                                <h3 className="text-lg font-bold text-blue-400 mb-2">💰 Inversión del Tipster</h3>
                                {formData.channel === 'Sport Apuestas' ? (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-slate-300">
                                                Monto del Tipster (€/$)
                                            </label>
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
                                ) : (
                                    <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl">
                                        <p className="text-blue-300 text-sm">
                                            El canal <strong>Premium</strong> no suele enviar su inversión real ni stake. Tú asignarás tu stake directamente en la sección de "Mi Gestión Personal" (Automáticamente asignado a <strong>Stake 11</strong> para maximizar ganancias).
                                        </p>
                                    </div>
                                )}
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
                                        <label className="text-sm font-medium text-slate-300">
                                            {formData.bet_type === 'double' ? 'Cuota (Total Final de la Apuesta Doble)' : t('newBet.odds')}
                                            {formData.channel === 'Sport Apuestas Premium' && <span className="text-slate-500 text-xs block mt-1">(Premium a veces no envía cuota, búscala manualmente)</span>}
                                        </label>
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
                            <br /><span className="text-xs text-emerald-400/80 mt-1 inline-block">💡 <b>Recomendación:</b> Calcula este monto sobre tu Bank Inicial mensual (fixed staking), no sobre el bank diario, para no castigar tus rachas.</span>
                        </p>

                        <div className={`space-y-6 relative z-10 ${isTracking ? 'opacity-50 pointer-events-none' : ''}`}>
                            {/* Visual Slider Auto-Updated */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">Tu Stake Asignado</label>
                                <input
                                    type="range"
                                    name="stake_norm"
                                    min="1" max={formData.channel === 'Sport Apuestas Premium' ? "11" : "10"}
                                    value={formData.stake_norm}
                                    onChange={handleChange}
                                    className="w-full h-2 bg-slate-800 border border-slate-700 rounded-lg appearance-none cursor-pointer mt-4
                                           [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110
                                           [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:transition-all [&::-moz-range-thumb]:hover:scale-110"
                                />
                                <div className="text-center text-emerald-400 font-bold text-lg mt-2">{formData.stake_norm} / {formData.channel === 'Sport Apuestas Premium' ? '11' : '10'}</div>
                            </div>

                            {userProfile && (
                                <div className="bg-slate-900/80 p-5 rounded-xl border border-slate-700/50 space-y-4">
                                    <div className="flex justify-between items-center text-sm">
                                        <span className="text-slate-400">💵 Inversión Real (Tuya):</span>
                                        <span className="text-white font-bold font-mono text-lg">
                                            ${(
                                                (parseFloat(formData.stake_norm) / (formData.channel === 'Sport Apuestas Premium' ? 11 : 10)) *
                                                ((channelProfiles.find(cp => cp.channel_name === formData.channel)?.starting_bankroll || userProfile.starting_bankroll) * userProfile.stake10_percent)
                                            ).toFixed(2)}
                                        </span>
                                    </div>

                                    {formData.odds && !isNaN(parseFloat(formData.odds)) && (
                                        <div className="flex justify-between items-center text-sm border-t border-slate-700/50 pt-4">
                                            <span className="text-slate-400">✅ Tu Ganancia Estimada:</span>
                                            <span className="text-emerald-400 font-bold font-mono text-2xl">
                                                +${(
                                                    ((parseFloat(formData.stake_norm) / (formData.channel === 'Sport Apuestas Premium' ? 11 : 10)) *
                                                        ((channelProfiles.find(cp => cp.channel_name === formData.channel)?.starting_bankroll || userProfile.starting_bankroll) * userProfile.stake10_percent)) * parseFloat(formData.odds) -
                                                    ((parseFloat(formData.stake_norm) / (formData.channel === 'Sport Apuestas Premium' ? 11 : 10)) *
                                                        ((channelProfiles.find(cp => cp.channel_name === formData.channel)?.starting_bankroll || userProfile.starting_bankroll) * userProfile.stake10_percent))
                                                ).toFixed(2)}
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
