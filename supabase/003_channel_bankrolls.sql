-- Migration 003: Channel Bankrolls
-- Creates a table to split the default bankroll into channel-specific tracking

CREATE TABLE IF NOT EXISTS channel_bankrolls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES bankroll_profiles(id) ON DELETE CASCADE,
    channel_name TEXT NOT NULL,
    starting_bankroll NUMERIC NOT NULL DEFAULT 100,
    current_bankroll NUMERIC NOT NULL DEFAULT 100,
    stake_scale INTEGER NOT NULL DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(profile_id, channel_name)
);

-- Insert the two main channels for the existing default profile
-- We'll try to insert for all profiles.
INSERT INTO channel_bankrolls (profile_id, channel_name, starting_bankroll, current_bankroll, stake_scale)
SELECT id, 'Sport Apuestas', 100, 100, 10 FROM bankroll_profiles
ON CONFLICT (profile_id, channel_name) DO NOTHING;

INSERT INTO channel_bankrolls (profile_id, channel_name, starting_bankroll, current_bankroll, stake_scale)
SELECT id, 'Sport Apuestas Premium', 100, 100, 11 FROM bankroll_profiles
ON CONFLICT (profile_id, channel_name) DO NOTHING;
