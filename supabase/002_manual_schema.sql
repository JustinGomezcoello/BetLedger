-- DROP OLD TABLES (if they exist from the automated project)
DROP TABLE IF EXISTS bet_simulations CASCADE;
DROP TABLE IF EXISTS bankroll_profiles CASCADE;
DROP TABLE IF EXISTS result_events CASCADE;
DROP TABLE IF EXISTS bet_legs CASCADE;
DROP TABLE IF EXISTS bets CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS channels CASCADE;

-- DDL for Manual BetLedger

-- 1. bankroll_profiles
CREATE TABLE bankroll_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id), -- Optional for Vercel Auth
    name TEXT NOT NULL,
    starting_bankroll NUMERIC NOT NULL DEFAULT 100,
    current_bankroll NUMERIC NOT NULL DEFAULT 100,
    stake10_percent NUMERIC NOT NULL DEFAULT 0.05,
    use_compounding BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Default profile insert (User will edit this via UI)
INSERT INTO bankroll_profiles (name, starting_bankroll, current_bankroll, stake10_percent, use_compounding)
VALUES ('Default Profile', 100, 100, 0.05, true);

-- 2. manual_bets
CREATE TABLE manual_bets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES bankroll_profiles(id),
    bet_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    bet_type TEXT NOT NULL, -- 'single' | 'double' | 'parlay'
    category TEXT, -- e.g., 'Football', 'Tennis', 'E-Sports'
    selection TEXT NOT NULL, -- e.g., 'Real Madrid vs Barcelona'
    description TEXT, -- e.g., 'Gana o Empata + Mas de 2.5 Goles'
    odds NUMERIC NOT NULL,
    stake_norm INTEGER NOT NULL CHECK (stake_norm BETWEEN 1 AND 10), -- 1 to 10
    stake_amount NUMERIC NOT NULL, -- The actual $ amount calculated when placing bet
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'won' | 'lost' | 'void'
    profit NUMERIC, -- Will be populated when status changes
    channel TEXT DEFAULT 'Personal', -- e.g., 'Sport Apuestas', 'Sport Apuestas Premium', 'Personal'
    tipster_amount NUMERIC, -- How much the tipster said they bet
    tipster_profit NUMERIC, -- How much the tipster won/lost
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_manual_bets_date ON manual_bets (bet_date DESC);
CREATE INDEX idx_manual_bets_status ON manual_bets (status);
