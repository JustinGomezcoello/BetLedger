import { Check, X, Ban, AlertCircle } from 'lucide-react';

const mockReviews = [
    {
        id: 'rev_1',
        channel: 'Premium',
        resultText: "✅✅✅✅ BUAAAA VAMOSSS",
        date: '2026-02-25 12:00',
        candidates: [
            { id: 'bet_1', selection: 'Real Madrid vs Barça', odds: 1.85, stake: 5 },
            { id: 'bet_2', selection: 'Nadal to win', odds: 1.50, stake: 10 },
        ]
    }
];

export const ReviewQueue = () => {
    return (
        <div className="p-8">
            <div className="mb-6">
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    Needs Review
                    <span className="bg-red-500/20 text-red-400 text-sm py-1 px-3 rounded-full border border-red-500/20 flex items-center">
                        <span className="w-2 h-2 rounded-full bg-red-500 mr-2 animate-pulse"></span>
                        1 Pending
                    </span>
                </h1>
                <p className="text-slate-400 mt-2">Ambiguous results that require manual matching</p>
            </div>

            <div className="space-y-6">
                {mockReviews.map((rev) => (
                    <div key={rev.id} className="glass-card rounded-2xl overflow-hidden border border-yellow-500/20 shadow-[0_0_15px_rgba(234,179,8,0.05)]">
                        <div className="bg-yellow-500/10 p-4 border-b border-yellow-500/20 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="bg-yellow-500/20 p-2 rounded-lg">
                                    <AlertCircle className="text-yellow-500" size={20} />
                                </div>
                                <div>
                                    <h3 className="font-medium text-yellow-500">Unmatched Result Event ({rev.channel})</h3>
                                    <p className="text-xs text-yellow-500/70">{rev.date}</p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
                            {/* Event Info */}
                            <div>
                                <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Tipster's Message</h4>
                                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                                    <p className="text-lg whitespace-pre-wrap">{rev.resultText}</p>
                                </div>
                                {/* Media placeholder */}
                                <div className="mt-4 bg-slate-800/50 p-4 rounded-xl border border-slate-700 flex items-center justify-center h-32 text-slate-500 italic">
                                    No image attached
                                </div>
                            </div>

                            {/* Candidates */}
                            <div>
                                <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Select Target Bet</h4>
                                <div className="space-y-3">
                                    {rev.candidates.map((bet) => (
                                        <div key={bet.id} className="bg-slate-800/50 border border-slate-700/50 p-4 rounded-xl hover:border-blue-500/50 transition-colors group">
                                            <div className="flex justify-between items-start mb-4">
                                                <div>
                                                    <p className="font-medium text-white group-hover:text-blue-400 transition-colors">{bet.selection}</p>
                                                    <p className="text-sm text-slate-400">Odds: <span className="text-blue-400">{bet.odds.toFixed(2)}</span> | Stake: {bet.stake}</p>
                                                </div>
                                            </div>
                                            <div className="flex space-x-2">
                                                <button className="flex-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 py-2 rounded-lg text-sm font-medium transition-colors flex justify-center items-center gap-2 border border-emerald-500/20">
                                                    <Check size={16} /> WON
                                                </button>
                                                <button className="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 py-2 rounded-lg text-sm font-medium transition-colors flex justify-center items-center gap-2 border border-red-500/20">
                                                    <X size={16} /> LOST
                                                </button>
                                                <button className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm font-medium transition-colors flex justify-center items-center gap-2">
                                                    <Ban size={16} /> VOID
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
