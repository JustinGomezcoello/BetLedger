-- Safe baseline for a new BetLedger project.
-- This intentionally contains no DROP statements and inserts no owner data.

begin;

create extension if not exists pgcrypto;

create table if not exists public.bankroll_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete set null,
    name text not null,
    starting_bankroll numeric not null default 100 check (starting_bankroll >= 0),
    current_bankroll numeric not null default 100 check (current_bankroll >= 0),
    stake10_percent numeric not null default 0.05 check (stake10_percent > 0 and stake10_percent <= 1),
    use_compounding boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.manual_bets (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.bankroll_profiles(id) on delete restrict,
    bet_date timestamptz not null default now(),
    bet_type text not null check (bet_type in ('single', 'double', 'parlay')),
    category text,
    selection text not null,
    description text,
    odds numeric not null check (odds > 1 and odds <= 1000),
    stake_norm integer not null check (stake_norm between 1 and 15),
    stake_amount numeric not null check (stake_amount >= 0),
    status text not null default 'pending'
        check (status in ('pending', 'won', 'lost', 'void', 'cancelled')),
    profit numeric,
    channel text not null default 'Personal',
    tipster_amount numeric,
    tipster_profit numeric,
    created_at timestamptz not null default now()
);

create index if not exists idx_manual_bets_date on public.manual_bets (bet_date desc);
create index if not exists idx_manual_bets_status on public.manual_bets (status);

create table if not exists public.channel_bankrolls (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.bankroll_profiles(id) on delete cascade,
    channel_name text not null,
    starting_bankroll numeric not null default 100 check (starting_bankroll >= 0),
    current_bankroll numeric not null default 100 check (current_bankroll >= 0),
    stake_scale integer not null default 10 check (stake_scale between 1 and 15),
    created_at timestamptz not null default now(),
    unique (profile_id, channel_name)
);

commit;
