import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, AlertCircle, PlusCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { errorMessage, placeManualBet } from '../lib/ledger';
import type { BankrollProfile, ChannelBankroll, ManualBetInput } from '../lib/ledger';
import { registerPaperRecommendation } from '../lib/prediction-data';

type RecommendationState = {
    recommendation?: {
        recommendationId: string;
        fixtureId: string;
        selection: string;
        odds: number | null;
        description: string;
    };
};

export const NewBet = () => {
    const { t } = useTranslation();
    const location = useLocation();
    const recommendation = (location.state as RecommendationState | null)?.recommendation;
    const [formData, setFormData] = useState({
        bet_date: '',
        bet_type: recommendation ? 'single' : '',
        category: recommendation ? 'Football' : '',
        selection: recommendation?.selection ?? '',
        description: recommendation?.description ?? '',
        odds: recommendation?.odds?.toString() ?? '',
        stake_norm: recommendation ? '' : '5',
        channel: '',
        tipster_amount: ''
    });

    const [leg2, setLeg2] = useState({
        selection: '',
        description: '',
        odds: '',
        category: ''
    });

    const [tipsterStakeInput, setTipsterStakeInput] = useState('');
    const [isTracking, setIsTracking] = useState(false);
    const [confirmedRegistration, setConfirmedRegistration] = useState(false);
    const [submissionIdempotencyKey, setSubmissionIdempotencyKey] = useState(() => crypto.randomUUID());

    const [userProfile, setUserProfile] = useState<BankrollProfile | null>(null);
    const [channelProfiles, setChannelProfiles] = useState<ChannelBankroll[]>([]);

    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchProfile = async () => {
            const { data } = await supabase.from('bankroll_profiles').select('id, starting_bankroll, current_bankroll, stake10_percent, use_compounding').limit(1).single();
            if (data) {
                setUserProfile(data as BankrollProfile);
            }
            const { data: cbData } = await supabase.from('channel_bankrolls').select('*');
            if (cbData) {
                setChannelProfiles(cbData as ChannelBankroll[]);
            }
        };
        fetchProfile();
    }, []);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState('');

    const stakeLimitForChannel = (channel: string) => {
        const configured = Number(
            channelProfiles.find((profile) => profile.channel_name === channel)?.max_stake_norm,
        );
        if (Number.isInteger(configured) && configured >= 1 && configured <= 15) return configured;
        return channel === 'Sport Apuestas Premium' ? 15 : 10;
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData({ ...formData, [name]: value });

        // Auto-adjust scale based on channel
        if (name === 'channel') {
            const nextLimit = stakeLimitForChannel(value);
            if (recommendation) {
                setTipsterStakeInput('');
                setFormData(prev => ({
                    ...prev,
                    channel: value,
                    tipster_amount: '',
                    stake_norm: Number(prev.stake_norm) > nextLimit
                        ? ''
                        : prev.stake_norm,
                }));
                return;
            }
            if (value === 'Sport Apuestas Premium') {
                setTipsterStakeInput('');
                setFormData(prev => ({ ...prev, channel: value, tipster_amount: '', stake_norm: String(nextLimit) }));
            } else {
                setFormData(prev => ({
                    ...prev,
                    channel: value,
                    stake_norm: parseInt(prev.stake_norm) > nextLimit
                        ? String(Math.min(5, nextLimit))
                        : prev.stake_norm
                }));
            }
            return;
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Tipster Amount is only logically required for Standard 'Sport Apuestas' as Premium often omits it.
        const isPremium = formData.channel === 'Sport Apuestas Premium';

        if (!formData.selection || !formData.odds || !formData.channel || !formData.bet_date || !formData.bet_type || !formData.category || !formData.stake_norm) {
            setError('Por favor, completa todos los campos obligatorios, incluido el stake elegido por ti.');
            return;
        }

        if (!recommendation && !isPremium && (!formData.tipster_amount || !tipsterStakeInput)) {
            setError('Para el canal Sport Apuestas normal, debes llenar el monto y stake del Tipster.');
            return;
        }

        if (recommendation && !confirmedRegistration) {
            setError('Confirma explícitamente que revisaste la apuesta antes de registrarla.');
            return;
        }

        if (formData.bet_type === 'double' && (!leg2.selection || !leg2.odds || !leg2.category)) {
            setError('Por favor, completa la selección, categoría y cuota de la Apuesta 2.');
            return;
        }

        const selectedStakeNorm = Number(formData.stake_norm);
        const selectedStakeLimit = stakeLimitForChannel(formData.channel);
        if (!Number.isInteger(selectedStakeNorm) || selectedStakeNorm < 1 || selectedStakeNorm > selectedStakeLimit) {
            setError(`El stake debe ser un entero entre 1 y ${selectedStakeLimit} para este canal.`);
            return;
        }

        setLoading(true);
        setError('');
        setSuccess(false);

        try {
            // Calculate Tipster Data
            let tAmount = parseFloat(formData.tipster_amount) || 0;
            if (!recommendation && formData.channel === 'Sport Apuestas Premium') {
                // Tipster Bankroll is conceptually 20,000. Stake N = N% of 20k.
                tAmount = (parseInt(formData.stake_norm) / 100) * 20000;
            }

            // Calculate final fields based on bet type
            let finalSelection = formData.selection;
            let finalDescription = formData.description;
            let finalCategory = formData.category;
            // The odds field now represents the TOTAL odds for both single and double bets
            let finalOdds = parseFloat(formData.odds);

            if (formData.bet_type === 'double') {
                finalSelection = `${formData.selection} + ${leg2.selection}`;
                finalDescription = `${formData.description} | ${leg2.description}`;
                finalCategory = `${formData.category} | ${leg2.category}`;
                finalOdds = (parseFloat(formData.odds) || 1) * (parseFloat(leg2.odds) || 1);
            }

            const betInput: ManualBetInput = {
                profile_id: userProfile?.id,
                bet_date: new Date(formData.bet_date).toISOString(),
                bet_type: formData.bet_type as ManualBetInput['bet_type'],
                category: finalCategory,
                selection: finalSelection,
                description: finalDescription,
                odds: finalOdds,
                stake_norm: parseInt(formData.stake_norm),
                channel: formData.channel,
                tipster_amount: tAmount > 0 ? tAmount : null,
                is_tracking: isTracking,
            };

            if (recommendation) {
                await registerPaperRecommendation(recommendation.recommendationId, betInput, submissionIdempotencyKey);
            } else {
                await placeManualBet(betInput, submissionIdempotencyKey);
            }

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
            setConfirmedRegistration(false);
            setSubmissionIdempotencyKey(crypto.randomUUID());
            setLeg2({
                selection: '',
                description: '',
                odds: '',
                category: ''
            });

        } catch (err: unknown) {
            console.error(err);
            setError(errorMessage(err, t('newBet.error', 'Error al guardar la apuesta.')));
        } finally {
            setLoading(false);
        }
    };

    const selectedChannelProfile = channelProfiles.find((profile) => profile.channel_name === formData.channel);
    const selectedStakeLimit = stakeLimitForChannel(formData.channel);
    const stakeBase = userProfile?.use_compounding
        ? (selectedChannelProfile?.current_bankroll ?? userProfile.current_bankroll)
        : (selectedChannelProfile?.starting_bankroll ?? userProfile?.starting_bankroll ?? 0);
    const selectedStake = Number(formData.stake_norm);
    const previewStake = userProfile && Number.isFinite(selectedStake) && selectedStake > 0
        ? stakeBase * Number(userProfile.stake10_percent) * selectedStake / 10
        : null;

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
                                    <option value="" disabled>Selecciona el canal...</option>
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
                                <label className="text-sm font-medium text-slate-300">{t('newBet.type')}</label>
                                <select
                                    name="bet_type"
                                    value={formData.bet_type}
                                    onChange={handleChange}
                                    disabled={Boolean(recommendation)}
                                    required
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-semibold disabled:cursor-not-allowed disabled:opacity-70"
                                >
                                    <option value="" disabled>Selecciona un tipo...</option>
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
                                {recommendation ? (
                                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                                        <h3 className="font-bold text-amber-200">Sin stake sugerido</h3>
                                        <p className="mt-1 text-sm leading-6 text-amber-100/80">
                                            El modelo aporta probabilidad y valor, pero no decide cuánto apostar. Elige tu stake manualmente y confirma el registro al final.
                                        </p>
                                    </div>
                                ) : (<>
                                <h3 className="text-lg font-bold text-blue-400 mb-2">💰 Inversión del Tipster</h3>
                                {formData.channel === 'Sport Apuestas' ? (
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                            <div className="space-y-2">
                                                <label className="text-sm font-medium text-slate-300">
                                                    Monto del Tipster ($)
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
                                                        const valStr = e.target.value;
                                                        setTipsterStakeInput(valStr);
                                                        const val = parseFloat(valStr);
                                                        if (!isNaN(val)) {
                                                            let suggested = Math.round(val);
                                                            if (suggested < 1) suggested = 1;
                                                            if (suggested > 10) suggested = 10;

                                                            let calculatedAmount = 0;
                                                            if (val === 1) {
                                                                calculatedAmount = 200;
                                                            } else {
                                                                calculatedAmount = val * 200;
                                                            }

                                                            setFormData(prev => ({
                                                                ...prev,
                                                                stake_norm: suggested.toString(),
                                                                tipster_amount: calculatedAmount.toString()
                                                            }));
                                                        }
                                                    }}
                                                    placeholder="Ej. 10"
                                                    className="w-full bg-slate-900 border border-blue-500/30 rounded-xl px-4 py-3 text-blue-300 font-mono text-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all"
                                                />
                                            </div>
                                        </div>
                                        <div className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-xl flex items-start gap-3 mt-4 mt-2">
                                            <AlertCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                                            <div>
                                                <p className="text-emerald-300 font-bold mb-1 text-sm">💡 Guía para Apuestas Live (Sin Stake Especificado)</p>
                                                <p className="text-emerald-200/80 text-xs leading-relaxed">
                                                    Si el tipster envía un pick <strong>Live</strong> y no indica el Stake, fíjate en su monto apostado:<br />
                                                    • <strong>$1000</strong> apostados por él = <strong>Stake 1</strong> (Equivale a $200 para ti)<br />
                                                    • <strong>$1200</strong> apostados por él = <strong>Stake 2</strong> (Equivale a $400 para ti)<br />
                                                    <em>* Sube tu stake en 1 por cada $200 adicionales que él apueste por encima de $1000.</em>
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl flex items-center justify-between">
                                        <div>
                                            <p className="text-blue-300 font-bold mb-1">
                                                Inversión Premium (Stake {formData.stake_norm})
                                            </p>
                                            <p className="text-blue-300 text-xs max-w-sm">
                                                Bankroll del Tipster: $20,000. <strong>1 Unit = 1% ($200)</strong>.
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-2xl font-bold font-mono text-emerald-400">
                                                ${((parseInt(formData.stake_norm) / 100) * 20000).toFixed(2)}
                                            </div>
                                            <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider mt-1">
                                                Stake {formData.stake_norm}
                                            </div>
                                        </div>
                                    </div>
                                )}
                                </>)}
                            </div>

                            <div className="space-y-4 md:col-span-2 mt-4">
                                <h3 className="text-lg font-bold text-blue-400 border-b border-slate-700 pb-2">
                                    {formData.bet_type === 'double' ? t('newBet.leg1', 'Apuesta 1 (Leg 1)') : t('newBet.details', 'Detalles de la Apuesta')}
                                </h3>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium text-slate-300">
                                            {formData.bet_type === 'double' ? 'Categoría (Leg 1)' : t('newBet.category')}
                                        </label>
                                        <input
                                            type="text"
                                            name="category"
                                            value={formData.category}
                                            onChange={handleChange}
                                            readOnly={Boolean(recommendation)}
                                            placeholder={t('newBet.catPlaceholder')}
                                            required
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium text-slate-300">{t('newBet.selection')}</label>
                                        <input
                                            type="text"
                                            name="selection"
                                            value={formData.selection}
                                            onChange={handleChange}
                                            readOnly={Boolean(recommendation)}
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
                                            readOnly={Boolean(recommendation)}
                                            placeholder={t('newBet.descPlaceholder')}
                                            rows={2}
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-slate-300">
                                            {t('newBet.odds', 'Cuota')}
                                            {!recommendation && formData.channel === 'Sport Apuestas Premium' && <span className="text-slate-500 text-xs block mt-1">(Premium a veces no envía cuota, búscala manualmente)</span>}
                                        </label>
                                        <input
                                            type="number"
                                            name="odds"
                                            step="0.001"
                                            min="1.01"
                                            value={formData.odds}
                                            onChange={handleChange}
                                            readOnly={Boolean(recommendation)}
                                            placeholder="Ej. 1.85"
                                            required
                                            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono"
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
                                            <label className="text-sm font-medium text-slate-300">Categoría (Leg 2)</label>
                                            <input
                                                type="text"
                                                value={leg2.category}
                                                onChange={(e) => setLeg2({ ...leg2, category: e.target.value })}
                                                placeholder={t('newBet.catPlaceholder')}
                                                required
                                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
                                            />
                                        </div>

                                        <div className="space-y-2 md:col-span-1">
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

                                        <div className="space-y-2 md:col-span-1">
                                            <label className="text-sm font-medium text-slate-300">Cuota</label>
                                            <input
                                                type="number"
                                                step="0.001"
                                                min="1.01"
                                                value={leg2.odds}
                                                onChange={(e) => setLeg2({ ...leg2, odds: e.target.value })}
                                                placeholder="Ej. 1.45"
                                                required
                                                className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono"
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

                                    <div className="mt-6 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex justify-between items-center text-emerald-400">
                                        <span className="font-semibold">Cuota Combinada (Overall Odds):</span>
                                        <span className="font-mono text-2xl font-bold">
                                            {formData.odds && leg2.odds ? ((parseFloat(formData.odds) || 1) * (parseFloat(leg2.odds) || 1)).toFixed(3) : "1.000"}
                                        </span>
                                    </div>
                                </div>
                            )}

                        </div>

                        {recommendation && (
                            <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                                <input
                                    type="checkbox"
                                    checked={confirmedRegistration}
                                    onChange={(event) => setConfirmedRegistration(event.target.checked)}
                                    className="mt-0.5 h-5 w-5 rounded border-amber-400/60 bg-slate-900 text-amber-500"
                                />
                                <span>Confirmo que revisé la selección, la cuota, la fecha, el canal y el stake que elegí manualmente.</span>
                            </label>
                        )}

                        <div className="pt-6 flex justify-end">
                            <button
                                type="submit"
                                disabled={loading || Boolean(recommendation && !confirmedRegistration)}
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
                            {recommendation
                                ? 'El modelo no propone stake. Esta sección sólo calcula el monto después de que tú elijas uno.'
                                : 'Aislando el tamaño del tipster a tu capital real.'}
                            {!recommendation && <><br /><span className="text-xs text-emerald-400/80 mt-1 inline-block">💡 <b>Recomendación:</b> Calcula este monto sobre tu Bank Inicial mensual (fixed staking), no sobre el bank diario, para no castigar tus rachas.</span></>}
                        </p>

                        <div className={`space-y-6 relative z-10 ${isTracking && !recommendation ? 'opacity-50 pointer-events-none' : ''}`}>
                            <div className="space-y-2">
                                <label htmlFor="stake-norm" className="text-sm font-medium text-slate-300">
                                    {recommendation ? 'Stake elegido por ti' : 'Tu Stake Asignado'}
                                </label>
                                {recommendation ? (
                                    <input
                                        id="stake-norm"
                                        type="number"
                                        name="stake_norm"
                                        min="1"
                                        max={selectedStakeLimit}
                                        step="1"
                                        value={formData.stake_norm}
                                        onChange={handleChange}
                                        placeholder={formData.channel ? 'Escribe tu stake' : 'Primero selecciona el canal'}
                                        disabled={!formData.channel}
                                        required
                                        className="w-full rounded-xl border border-emerald-500/30 bg-slate-900 px-4 py-3 font-mono text-lg text-emerald-300 outline-none transition focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                ) : (
                                    <input
                                        id="stake-norm"
                                        type="range"
                                        name="stake_norm"
                                        min="1" max={selectedStakeLimit}
                                        value={formData.stake_norm}
                                        onChange={handleChange}
                                        className="w-full h-2 bg-slate-800 border border-slate-700 rounded-lg appearance-none cursor-pointer mt-4
                                               [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110
                                               [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:shadow-[0_0_15px_rgba(16,185,129,0.8)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:transition-all [&::-moz-range-thumb]:hover:scale-110"
                                    />
                                )}
                                <div className="text-center text-emerald-400 font-bold text-lg mt-2">{formData.stake_norm || '—'} / {selectedStakeLimit}</div>
                            </div>

                            {userProfile && (
                                <div className="bg-slate-900/80 p-5 rounded-xl border border-slate-700/50 space-y-4">
                                    <div className="flex justify-between items-center text-sm">
                                        <span className="text-slate-400">💵 Inversión Real (Tuya):</span>
                                        <span className="text-white font-bold font-mono text-lg">
                                            {previewStake === null ? '—' : `$${previewStake.toFixed(2)}`}
                                        </span>
                                    </div>

                                    {previewStake !== null && formData.odds && !isNaN(parseFloat(formData.odds)) && (
                                        <div className="flex justify-between items-center text-sm border-t border-slate-700/50 pt-4">
                                            <span className="text-slate-400">✅ Tu Ganancia Estimada:</span>
                                            <span className="text-emerald-400 font-bold font-mono text-2xl">
                                                +${(previewStake * (parseFloat(formData.odds) - 1)).toFixed(2)}
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
