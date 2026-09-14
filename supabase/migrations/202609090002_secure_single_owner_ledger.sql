-- BetLedger 004: single-owner security and transactional ledger hardening.
-- Incremental only: this migration never drops an existing table or row.

begin;

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.app_members (
    user_id uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'owner' check (role = 'owner'),
    created_at timestamptz not null default now()
);

-- A BetLedger installation intentionally has at most one owner.
create unique index if not exists app_members_single_owner_idx
    on public.app_members ((role))
    where role = 'owner';

create or replace function public.is_app_owner(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select p_user_id is not null
       and exists (
            select 1
            from public.app_members m
            where m.user_id = p_user_id
              and m.role = 'owner'
       );
$$;

revoke all on function public.is_app_owner(uuid) from public, anon;
grant execute on function public.is_app_owner(uuid) to authenticated, service_role;

create or replace function private.require_owner_id()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null or not public.is_app_owner(v_user_id) then
        raise exception 'owner authentication required' using errcode = '42501';
    end if;
    return v_user_id;
end;
$$;

revoke all on function private.require_owner_id() from public, anon, authenticated;

-- The production database already contains this table even though the original
-- SQL files did not version it. CREATE IF NOT EXISTS closes that schema drift.
create table if not exists public.monthly_configs (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null references public.bankroll_profiles(id) on delete cascade,
    month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    starting_bankroll numeric not null check (starting_bankroll >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (month, profile_id)
);

alter table public.bankroll_profiles
    add column if not exists owner_id uuid references auth.users(id) on delete restrict,
    add column if not exists updated_at timestamptz not null default now();

alter table public.channel_bankrolls
    add column if not exists owner_id uuid references auth.users(id) on delete restrict,
    add column if not exists max_stake_norm integer not null default 10,
    add column if not exists updated_at timestamptz not null default now();

alter table public.manual_bets
    add column if not exists owner_id uuid references auth.users(id) on delete restrict,
    add column if not exists idempotency_key text,
    add column if not exists updated_at timestamptz not null default now();

alter table public.monthly_configs
    add column if not exists owner_id uuid references auth.users(id) on delete restrict,
    add column if not exists updated_at timestamptz not null default now();

-- Premium currently permits stake 15. Keep the database aligned with that UI,
-- while the RPC below enforces each channel's own maximum.
alter table public.manual_bets drop constraint if exists manual_bets_stake_norm_check;
alter table public.manual_bets
    add constraint manual_bets_stake_norm_check
    check (stake_norm between 1 and 15) not valid;

alter table public.channel_bankrolls drop constraint if exists channel_bankrolls_max_stake_norm_check;
alter table public.channel_bankrolls
    add constraint channel_bankrolls_max_stake_norm_check
    check (max_stake_norm between 1 and 15) not valid;

update public.channel_bankrolls
set max_stake_norm = case
    when lower(channel_name) like '%premium%' then 15
    else greatest(1, least(15, coalesce(stake_scale, 10)))
end;

create unique index if not exists manual_bets_owner_idempotency_idx
    on public.manual_bets (owner_id, idempotency_key)
    where idempotency_key is not null;

create table if not exists public.ledger_operations (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    idempotency_key text not null,
    operation_type text not null check (
        operation_type in ('place_bet', 'settle_bet', 'cancel_bet', 'adjust_bankroll')
    ),
    entity_id uuid,
    response jsonb,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (owner_id, idempotency_key)
);

create table if not exists public.bankroll_events (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    profile_id uuid not null references public.bankroll_profiles(id) on delete restrict,
    channel_bankroll_id uuid references public.channel_bankrolls(id) on delete restrict,
    manual_bet_id uuid references public.manual_bets(id) on delete restrict,
    event_type text not null check (event_type in ('settlement', 'void', 'adjustment')),
    amount numeric not null,
    balance_before numeric not null,
    balance_after numeric not null,
    reason text,
    idempotency_key text not null,
    created_at timestamptz not null default now(),
    unique (owner_id, idempotency_key),
    check (balance_after = balance_before + amount)
);

create index if not exists bankroll_events_profile_created_idx
    on public.bankroll_events (profile_id, created_at desc);
create index if not exists bankroll_events_bet_idx
    on public.bankroll_events (manual_bet_id)
    where manual_bet_id is not null;

-- Ledger events are the reconciliation source of truth. Corrections must be
-- represented by a new compensating event, never by rewriting history.
create or replace function private.reject_immutable_ledger_event_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
    raise exception 'bankroll events are immutable; append a compensating adjustment'
        using errcode = '55000';
end;
$$;

revoke all on function private.reject_immutable_ledger_event_change()
    from public, anon, authenticated;

drop trigger if exists bankroll_events_reject_update_delete on public.bankroll_events;
create trigger bankroll_events_reject_update_delete
before update or delete on public.bankroll_events
for each row execute function private.reject_immutable_ledger_event_change();

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists bankroll_profiles_touch_updated_at on public.bankroll_profiles;
create trigger bankroll_profiles_touch_updated_at
before update on public.bankroll_profiles
for each row execute function private.touch_updated_at();

drop trigger if exists channel_bankrolls_touch_updated_at on public.channel_bankrolls;
create trigger channel_bankrolls_touch_updated_at
before update on public.channel_bankrolls
for each row execute function private.touch_updated_at();

drop trigger if exists manual_bets_touch_updated_at on public.manual_bets;
create trigger manual_bets_touch_updated_at
before update on public.manual_bets
for each row execute function private.touch_updated_at();

drop trigger if exists monthly_configs_touch_updated_at on public.monthly_configs;
create trigger monthly_configs_touch_updated_at
before update on public.monthly_configs
for each row execute function private.touch_updated_at();

-- Administrative, service-role-only bootstrap. It is deliberately not callable
-- by ordinary authenticated users, so public sign-up can never claim old data.
create or replace function public.configure_app_owner(p_user_id uuid, p_expected_email text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_existing_owner uuid;
    v_profile_id uuid;
begin
    if length(btrim(coalesce(p_expected_email, ''))) = 0
       or not exists (
           select 1 from auth.users
           where id = p_user_id
             and lower(email) = lower(btrim(p_expected_email))
       ) then
        raise exception 'unknown auth user' using errcode = '22023';
    end if;

    select user_id into v_existing_owner
    from public.app_members
    where role = 'owner';

    if v_existing_owner is not null and v_existing_owner <> p_user_id then
        raise exception 'an owner is already configured' using errcode = '23505';
    end if;

    insert into public.app_members (user_id, role)
    values (p_user_id, 'owner')
    on conflict (user_id) do update set role = excluded.role;

    update public.bankroll_profiles
    set owner_id = p_user_id,
        user_id = p_user_id
    where owner_id is null;

    update public.channel_bankrolls cb
    set owner_id = p_user_id
    where cb.owner_id is null
      and exists (
          select 1 from public.bankroll_profiles bp
          where bp.id = cb.profile_id and bp.owner_id = p_user_id
      );

    update public.manual_bets mb
    set owner_id = p_user_id
    where mb.owner_id is null
      and exists (
          select 1 from public.bankroll_profiles bp
          where bp.id = mb.profile_id and bp.owner_id = p_user_id
      );

    update public.monthly_configs mc
    set owner_id = p_user_id
    where mc.owner_id is null
      and exists (
          select 1 from public.bankroll_profiles bp
          where bp.id = mc.profile_id and bp.owner_id = p_user_id
      );

    if exists (
        select 1 from public.bankroll_profiles
        where owner_id <> p_user_id or user_id is distinct from p_user_id
    ) or exists (
        select 1 from public.channel_bankrolls where owner_id <> p_user_id
    ) or exists (
        select 1 from public.manual_bets where owner_id <> p_user_id
    ) or exists (
        select 1 from public.monthly_configs where owner_id <> p_user_id
    ) then
        raise exception 'legacy ledger rows belong to a different user; owner bootstrap aborted'
            using errcode = '23514';
    end if;

    -- Fail the bootstrap transaction if any legacy row remained unowned or
    -- violates the normalized stake bounds; a partial migration is unsafe.
    alter table public.bankroll_profiles alter column owner_id set not null;
    alter table public.channel_bankrolls alter column owner_id set not null;
    alter table public.manual_bets alter column owner_id set not null;
    alter table public.monthly_configs alter column owner_id set not null;
    alter table public.manual_bets validate constraint manual_bets_stake_norm_check;
    alter table public.channel_bankrolls validate constraint channel_bankrolls_max_stake_norm_check;

    -- New installations receive one private ledger only after the owner is
    -- configured. Existing installations keep every row and balance intact.
    if not exists (
        select 1 from public.bankroll_profiles where owner_id = p_user_id
    ) then
        insert into public.bankroll_profiles (
            user_id, owner_id, name, starting_bankroll, current_bankroll,
            stake10_percent, use_compounding
        ) values (
            p_user_id, p_user_id, 'BetLedger', 100, 100, 0.05, true
        ) returning id into v_profile_id;
    end if;

    for v_profile_id in
        select id from public.bankroll_profiles where owner_id = p_user_id
    loop
        insert into public.channel_bankrolls (
            profile_id, owner_id, channel_name, starting_bankroll,
            current_bankroll, stake_scale, max_stake_norm
        ) values
            (v_profile_id, p_user_id, 'Sport Apuestas', 100, 100, 10, 10),
            (v_profile_id, p_user_id, 'Sport Apuestas Premium', 100, 100, 11, 15)
        on conflict (profile_id, channel_name) do update
        set owner_id = coalesce(public.channel_bankrolls.owner_id, excluded.owner_id);
    end loop;

    -- Establish an immutable opening checkpoint for legacy and new balances.
    -- Historical settled rows are preserved verbatim; subsequent movements can
    -- be reconciled from this checkpoint without fabricating per-bet events.
    insert into public.bankroll_events (
        owner_id, profile_id, event_type, amount, balance_before,
        balance_after, reason, idempotency_key
    )
    select
        p_user_id, bp.id, 'adjustment',
        bp.current_bankroll - bp.starting_bankroll,
        bp.starting_bankroll, bp.current_bankroll,
        'Opening checkpoint after owner assignment',
        'owner-bootstrap:profile:' || bp.id::text
    from public.bankroll_profiles bp
    where bp.owner_id = p_user_id
    on conflict (owner_id, idempotency_key) do nothing;

    insert into public.bankroll_events (
        owner_id, profile_id, channel_bankroll_id, event_type, amount,
        balance_before, balance_after, reason, idempotency_key
    )
    select
        p_user_id, cb.profile_id, cb.id, 'adjustment',
        cb.current_bankroll - cb.starting_bankroll,
        cb.starting_bankroll, cb.current_bankroll,
        'Opening checkpoint after owner assignment',
        'owner-bootstrap:channel:' || cb.id::text
    from public.channel_bankrolls cb
    where cb.owner_id = p_user_id
    on conflict (owner_id, idempotency_key) do nothing;
end;
$$;

revoke all on function public.configure_app_owner(uuid, text) from public, anon, authenticated;
grant execute on function public.configure_app_owner(uuid, text) to service_role;

-- Deliberately no automatic owner binding. Operations must first disable public
-- signup, verify the intended email, and then call this service-role-only RPC.

create or replace function public.place_manual_bet(
    p_input jsonb,
    p_idempotency_key text
)
returns public.manual_bets
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_operation_id uuid;
    v_existing_operation public.ledger_operations%rowtype;
    v_profile public.bankroll_profiles%rowtype;
    v_channel public.channel_bankrolls%rowtype;
    v_bet public.manual_bets%rowtype;
    v_profile_id uuid;
    v_channel_name text := coalesce(nullif(btrim(p_input->>'channel'), ''), 'Personal');
    v_stake_norm integer;
    v_max_stake integer := 10;
    v_base_bankroll numeric;
    v_stake_amount numeric;
    v_is_tracking boolean := coalesce((p_input->>'is_tracking')::boolean, false);
    v_odds numeric;
    v_bet_type text := coalesce(nullif(p_input->>'bet_type', ''), 'single');
    v_selection text := btrim(coalesce(p_input->>'selection', ''));
begin
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
       or length(p_idempotency_key) > 160 then
        raise exception 'idempotency key must contain 8 to 160 characters'
            using errcode = '22023';
    end if;

    insert into public.ledger_operations (owner_id, idempotency_key, operation_type)
    values (v_owner_id, p_idempotency_key, 'place_bet')
    on conflict (owner_id, idempotency_key) do nothing
    returning id into v_operation_id;

    if v_operation_id is null then
        select * into v_existing_operation
        from public.ledger_operations
        where owner_id = v_owner_id and idempotency_key = p_idempotency_key;

        if v_existing_operation.operation_type <> 'place_bet'
           or v_existing_operation.entity_id is null then
            raise exception 'idempotency key already used for another operation'
                using errcode = '22023';
        end if;

        select * into strict v_bet
        from public.manual_bets
        where id = v_existing_operation.entity_id and owner_id = v_owner_id;
        return v_bet;
    end if;

    v_profile_id := nullif(p_input->>'profile_id', '')::uuid;
    if v_profile_id is null then
        select * into v_profile
        from public.bankroll_profiles
        where owner_id = v_owner_id
        order by created_at, id
        limit 1
        for update;
    else
        select * into v_profile
        from public.bankroll_profiles
        where id = v_profile_id and owner_id = v_owner_id
        for update;
    end if;

    if not found then
        raise exception 'bankroll profile not found' using errcode = 'P0002';
    end if;

    select * into v_channel
    from public.channel_bankrolls
    where profile_id = v_profile.id
      and owner_id = v_owner_id
      and channel_name = v_channel_name
    for update;

    if found then
        v_max_stake := v_channel.max_stake_norm;
        v_base_bankroll := case when v_profile.use_compounding
            then v_channel.current_bankroll else v_channel.starting_bankroll end;
    elsif v_channel_name = 'Personal' then
        v_base_bankroll := case when v_profile.use_compounding
            then v_profile.current_bankroll else v_profile.starting_bankroll end;
    else
        raise exception 'channel bankroll not found' using errcode = 'P0002';
    end if;

    v_stake_norm := (p_input->>'stake_norm')::integer;
    if v_stake_norm is null or v_stake_norm < 1 or v_stake_norm > v_max_stake then
        raise exception 'stake_norm must be between 1 and % for this channel', v_max_stake
            using errcode = '22023';
    end if;

    v_odds := (p_input->>'odds')::numeric;
    if v_odds is null or v_odds <= 1 or v_odds > 1000 then
        raise exception 'decimal odds must be greater than 1 and at most 1000'
            using errcode = '22023';
    end if;

    if v_selection = '' then
        raise exception 'selection is required' using errcode = '22023';
    end if;
    if v_bet_type not in ('single', 'double', 'parlay') then
        raise exception 'unsupported bet_type' using errcode = '22023';
    end if;

    -- stake10_percent is the fraction risked by Stake 10. Other stakes scale
    -- linearly from it; this fixes the previous UI/database mismatch.
    v_stake_amount := case when v_is_tracking then 0 else
        round(v_base_bankroll * v_profile.stake10_percent * v_stake_norm / 10.0, 2)
    end;

    insert into public.manual_bets (
        owner_id, profile_id, bet_date, bet_type, category, selection,
        description, odds, stake_norm, stake_amount, status, channel,
        tipster_amount, tipster_profit, idempotency_key
    ) values (
        v_owner_id,
        v_profile.id,
        coalesce(nullif(p_input->>'bet_date', '')::timestamptz, now()),
        v_bet_type,
        coalesce(nullif(p_input->>'category', ''), 'Football'),
        v_selection,
        nullif(p_input->>'description', ''),
        v_odds,
        v_stake_norm,
        v_stake_amount,
        'pending',
        v_channel_name,
        nullif(p_input->>'tipster_amount', '')::numeric,
        null,
        p_idempotency_key
    ) returning * into v_bet;

    update public.ledger_operations
    set entity_id = v_bet.id,
        response = to_jsonb(v_bet),
        completed_at = now()
    where id = v_operation_id;

    return v_bet;
end;
$$;

create or replace function public.settle_manual_bet(
    p_bet_id uuid,
    p_status text,
    p_idempotency_key text
)
returns public.manual_bets
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_operation_id uuid;
    v_existing_operation public.ledger_operations%rowtype;
    v_bet public.manual_bets%rowtype;
    v_profile public.bankroll_profiles%rowtype;
    v_channel public.channel_bankrolls%rowtype;
    v_profit numeric;
    v_tipster_profit numeric;
    v_profile_before numeric;
    v_channel_before numeric;
begin
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
       or length(p_idempotency_key) > 160 then
        raise exception 'idempotency key must contain 8 to 160 characters'
            using errcode = '22023';
    end if;
    if p_status not in ('won', 'lost', 'void') then
        raise exception 'status must be won, lost, or void' using errcode = '22023';
    end if;

    insert into public.ledger_operations (owner_id, idempotency_key, operation_type, entity_id)
    values (v_owner_id, p_idempotency_key, 'settle_bet', p_bet_id)
    on conflict (owner_id, idempotency_key) do nothing
    returning id into v_operation_id;

    if v_operation_id is null then
        select * into v_existing_operation
        from public.ledger_operations
        where owner_id = v_owner_id and idempotency_key = p_idempotency_key;

        if v_existing_operation.operation_type <> 'settle_bet'
           or v_existing_operation.entity_id <> p_bet_id then
            raise exception 'idempotency key already used for another operation'
                using errcode = '22023';
        end if;

        select * into strict v_bet
        from public.manual_bets
        where id = p_bet_id and owner_id = v_owner_id;
        if v_bet.status <> p_status then
            raise exception 'idempotency key was already used with a different settlement status'
                using errcode = '22023';
        end if;
        return v_bet;
    end if;

    select * into v_bet
    from public.manual_bets
    where id = p_bet_id and owner_id = v_owner_id
    for update;

    if not found then
        raise exception 'bet not found' using errcode = 'P0002';
    end if;
    if v_bet.status <> 'pending' then
        raise exception 'only pending bets can be settled' using errcode = '22023';
    end if;

    v_profit := case p_status
        when 'won' then round(v_bet.stake_amount * (v_bet.odds - 1), 2)
        when 'lost' then -v_bet.stake_amount
        else 0
    end;
    v_tipster_profit := case
        when v_bet.tipster_amount is null then null
        when p_status = 'won' then round(v_bet.tipster_amount * (v_bet.odds - 1), 2)
        when p_status = 'lost' then -v_bet.tipster_amount
        else 0
    end;

    select * into strict v_profile
    from public.bankroll_profiles
    where id = v_bet.profile_id and owner_id = v_owner_id
    for update;
    v_profile_before := v_profile.current_bankroll;

    update public.bankroll_profiles
    set current_bankroll = current_bankroll + v_profit
    where id = v_profile.id;

    insert into public.bankroll_events (
        owner_id, profile_id, manual_bet_id, event_type, amount,
        balance_before, balance_after, idempotency_key
    ) values (
        v_owner_id, v_profile.id, v_bet.id,
        case when p_status = 'void' then 'void' else 'settlement' end,
        v_profit, v_profile_before, v_profile_before + v_profit,
        p_idempotency_key || ':profile'
    );

    select * into v_channel
    from public.channel_bankrolls
    where profile_id = v_bet.profile_id
      and owner_id = v_owner_id
      and channel_name = coalesce(v_bet.channel, 'Personal')
    for update;

    if found then
        v_channel_before := v_channel.current_bankroll;
        update public.channel_bankrolls
        set current_bankroll = current_bankroll + v_profit
        where id = v_channel.id;

        insert into public.bankroll_events (
            owner_id, profile_id, channel_bankroll_id, manual_bet_id,
            event_type, amount, balance_before, balance_after, idempotency_key
        ) values (
            v_owner_id, v_profile.id, v_channel.id, v_bet.id,
            case when p_status = 'void' then 'void' else 'settlement' end,
            v_profit, v_channel_before, v_channel_before + v_profit,
            p_idempotency_key || ':channel'
        );
    end if;

    update public.manual_bets
    set status = p_status,
        profit = v_profit,
        tipster_profit = v_tipster_profit
    where id = v_bet.id
    returning * into v_bet;

    update public.ledger_operations
    set response = to_jsonb(v_bet), completed_at = now()
    where id = v_operation_id;

    return v_bet;
end;
$$;

create or replace function public.cancel_manual_bet(
    p_bet_id uuid,
    p_idempotency_key text
)
returns public.manual_bets
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_operation_id uuid;
    v_existing_operation public.ledger_operations%rowtype;
    v_bet public.manual_bets%rowtype;
begin
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
       or length(p_idempotency_key) > 160 then
        raise exception 'invalid idempotency key' using errcode = '22023';
    end if;

    insert into public.ledger_operations (owner_id, idempotency_key, operation_type, entity_id)
    values (v_owner_id, p_idempotency_key, 'cancel_bet', p_bet_id)
    on conflict (owner_id, idempotency_key) do nothing
    returning id into v_operation_id;

    if v_operation_id is null then
        select * into v_existing_operation
        from public.ledger_operations
        where owner_id = v_owner_id and idempotency_key = p_idempotency_key;
        if v_existing_operation.operation_type <> 'cancel_bet'
           or v_existing_operation.entity_id <> p_bet_id then
            raise exception 'idempotency key already used for another operation'
                using errcode = '22023';
        end if;
        select * into strict v_bet from public.manual_bets
        where id = p_bet_id and owner_id = v_owner_id;
        return v_bet;
    end if;

    select * into v_bet from public.manual_bets
    where id = p_bet_id and owner_id = v_owner_id
    for update;
    if not found then
        raise exception 'bet not found' using errcode = 'P0002';
    end if;
    if v_bet.status <> 'pending' then
        raise exception 'a settled bet cannot be cancelled' using errcode = '22023';
    end if;

    update public.manual_bets
    set status = 'cancelled', profit = 0
    where id = p_bet_id
    returning * into v_bet;

    update public.ledger_operations
    set response = to_jsonb(v_bet), completed_at = now()
    where id = v_operation_id;
    return v_bet;
end;
$$;

-- Owner-safe settings RPCs. Current bankroll is intentionally excluded; balance
-- corrections belong in the auditable adjustment RPC.
create or replace function public.update_bankroll_settings(
    p_profile_id uuid,
    p_starting_bankroll numeric,
    p_stake10_percent numeric,
    p_use_compounding boolean
)
returns public.bankroll_profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_profile public.bankroll_profiles%rowtype;
begin
    if p_starting_bankroll < 0
       or p_stake10_percent <= 0 or p_stake10_percent > 1 then
        raise exception 'invalid bankroll settings' using errcode = '22023';
    end if;

    update public.bankroll_profiles
    set starting_bankroll = p_starting_bankroll,
        stake10_percent = p_stake10_percent,
        use_compounding = p_use_compounding
    where id = p_profile_id and owner_id = v_owner_id
    returning * into v_profile;

    if not found then
        raise exception 'bankroll profile not found' using errcode = 'P0002';
    end if;
    return v_profile;
end;
$$;

create or replace function public.adjust_bankroll(
    p_profile_id uuid,
    p_channel_name text,
    p_new_balance numeric,
    p_reason text,
    p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_operation_id uuid;
    v_existing_operation public.ledger_operations%rowtype;
    v_profile public.bankroll_profiles%rowtype;
    v_channel public.channel_bankrolls%rowtype;
    v_before numeric;
    v_event public.bankroll_events%rowtype;
begin
    if p_new_balance < 0 or length(btrim(coalesce(p_reason, ''))) < 4 then
        raise exception 'a non-negative balance and reason are required' using errcode = '22023';
    end if;
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
       or length(p_idempotency_key) > 160 then
        raise exception 'invalid idempotency key' using errcode = '22023';
    end if;

    insert into public.ledger_operations (owner_id, idempotency_key, operation_type, entity_id)
    values (v_owner_id, p_idempotency_key, 'adjust_bankroll', p_profile_id)
    on conflict (owner_id, idempotency_key) do nothing
    returning id into v_operation_id;

    if v_operation_id is null then
        select * into strict v_existing_operation
        from public.ledger_operations
        where owner_id = v_owner_id and idempotency_key = p_idempotency_key;
        if v_existing_operation.operation_type <> 'adjust_bankroll'
           or v_existing_operation.entity_id <> p_profile_id then
            raise exception 'idempotency key already used for another operation'
                using errcode = '22023';
        end if;

        select * into strict v_event from public.bankroll_events
        where owner_id = v_owner_id and idempotency_key = p_idempotency_key;
        if v_event.balance_after is distinct from p_new_balance
           or v_event.reason is distinct from btrim(p_reason)
           or (
               nullif(btrim(coalesce(p_channel_name, '')), '') is null
               and v_event.channel_bankroll_id is not null
           )
           or (
               nullif(btrim(coalesce(p_channel_name, '')), '') is not null
               and not exists (
                   select 1
                   from public.channel_bankrolls cb
                   where cb.id = v_event.channel_bankroll_id
                     and cb.owner_id = v_owner_id
                     and cb.profile_id = p_profile_id
                     and cb.channel_name = p_channel_name
               )
           ) then
            raise exception 'idempotency key was already used with different adjustment data'
                using errcode = '22023';
        end if;
        return to_jsonb(v_event);
    end if;

    select * into v_profile from public.bankroll_profiles
    where id = p_profile_id and owner_id = v_owner_id for update;
    if not found then
        raise exception 'bankroll profile not found' using errcode = 'P0002';
    end if;

    if nullif(btrim(coalesce(p_channel_name, '')), '') is null then
        v_before := v_profile.current_bankroll;
        update public.bankroll_profiles set current_bankroll = p_new_balance
        where id = v_profile.id;
        insert into public.bankroll_events (
            owner_id, profile_id, event_type, amount, balance_before,
            balance_after, reason, idempotency_key
        ) values (
            v_owner_id, v_profile.id, 'adjustment', p_new_balance - v_before,
            v_before, p_new_balance, btrim(p_reason), p_idempotency_key
        ) returning * into v_event;
    else
        select * into v_channel from public.channel_bankrolls
        where profile_id = p_profile_id and owner_id = v_owner_id
          and channel_name = p_channel_name for update;
        if not found then
            raise exception 'channel bankroll not found' using errcode = 'P0002';
        end if;
        v_before := v_channel.current_bankroll;
        update public.channel_bankrolls set current_bankroll = p_new_balance
        where id = v_channel.id;
        insert into public.bankroll_events (
            owner_id, profile_id, channel_bankroll_id, event_type, amount,
            balance_before, balance_after, reason, idempotency_key
        ) values (
            v_owner_id, v_profile.id, v_channel.id, 'adjustment',
            p_new_balance - v_before, v_before, p_new_balance,
            btrim(p_reason), p_idempotency_key
        ) returning * into v_event;
    end if;

    update public.ledger_operations
    set response = to_jsonb(v_event), completed_at = now()
    where id = v_operation_id;
    return to_jsonb(v_event);
end;
$$;

create or replace function public.update_channel_bankroll_settings(
    p_channel_id uuid,
    p_starting_bankroll numeric,
    p_max_stake_norm integer
)
returns public.channel_bankrolls
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_channel public.channel_bankrolls%rowtype;
begin
    if p_starting_bankroll < 0 or p_max_stake_norm < 1 or p_max_stake_norm > 15 then
        raise exception 'invalid channel bankroll settings' using errcode = '22023';
    end if;

    update public.channel_bankrolls
    set starting_bankroll = p_starting_bankroll,
        max_stake_norm = p_max_stake_norm
    where id = p_channel_id and owner_id = v_owner_id
    returning * into v_channel;

    if not found then
        raise exception 'channel bankroll not found' using errcode = 'P0002';
    end if;
    return v_channel;
end;
$$;

create or replace function public.upsert_monthly_config(
    p_profile_id uuid,
    p_month text,
    p_starting_bankroll numeric
)
returns public.monthly_configs
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_config public.monthly_configs%rowtype;
begin
    if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_starting_bankroll < 0 then
        raise exception 'invalid monthly configuration' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.bankroll_profiles
        where id = p_profile_id and owner_id = v_owner_id
    ) then
        raise exception 'bankroll profile not found' using errcode = 'P0002';
    end if;

    insert into public.monthly_configs (
        owner_id, profile_id, month, starting_bankroll
    ) values (
        v_owner_id, p_profile_id, p_month, p_starting_bankroll
    )
    on conflict (month, profile_id) do update
    set starting_bankroll = excluded.starting_bankroll,
        owner_id = excluded.owner_id
    returning * into v_config;
    return v_config;
end;
$$;

-- RLS: legacy and ledger data are invisible until the owner has been bound.
alter table public.app_members enable row level security;
alter table public.bankroll_profiles enable row level security;
alter table public.channel_bankrolls enable row level security;
alter table public.manual_bets enable row level security;
alter table public.monthly_configs enable row level security;
alter table public.ledger_operations enable row level security;
alter table public.bankroll_events enable row level security;

-- Remove any legacy policies, regardless of their old names. The original
-- manual schema was deployed interactively, so policy names cannot be trusted.
do $$
declare
    v_table text;
    v_policy text;
begin
    foreach v_table in array array[
        'app_members', 'bankroll_profiles', 'channel_bankrolls', 'manual_bets',
        'monthly_configs', 'ledger_operations', 'bankroll_events'
    ] loop
        for v_policy in
            select policyname from pg_policies
            where schemaname = 'public' and tablename = v_table
        loop
            execute format('drop policy if exists %I on public.%I', v_policy, v_table);
        end loop;
    end loop;
end;
$$;

drop policy if exists app_members_owner_select on public.app_members;
create policy app_members_owner_select on public.app_members
for select to authenticated
using (user_id = auth.uid() and role = 'owner');

drop policy if exists bankroll_profiles_owner_select on public.bankroll_profiles;
create policy bankroll_profiles_owner_select on public.bankroll_profiles
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

drop policy if exists channel_bankrolls_owner_select on public.channel_bankrolls;
create policy channel_bankrolls_owner_select on public.channel_bankrolls
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

drop policy if exists manual_bets_owner_select on public.manual_bets;
create policy manual_bets_owner_select on public.manual_bets
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

drop policy if exists monthly_configs_owner_select on public.monthly_configs;
create policy monthly_configs_owner_select on public.monthly_configs
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

drop policy if exists ledger_operations_owner_select on public.ledger_operations;
create policy ledger_operations_owner_select on public.ledger_operations
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

drop policy if exists bankroll_events_owner_select on public.bankroll_events;
create policy bankroll_events_owner_select on public.bankroll_events
for select to authenticated
using (owner_id = auth.uid() and public.is_app_owner());

revoke all on table public.app_members from public, anon, authenticated;
revoke all on table public.bankroll_profiles from public, anon, authenticated;
revoke all on table public.channel_bankrolls from public, anon, authenticated;
revoke all on table public.manual_bets from public, anon, authenticated;
revoke all on table public.monthly_configs from public, anon, authenticated;
revoke all on table public.ledger_operations from public, anon, authenticated;
revoke all on table public.bankroll_events from public, anon, authenticated;

grant select on table public.app_members to authenticated;
grant select on table public.bankroll_profiles to authenticated;
grant select on table public.channel_bankrolls to authenticated;
grant select on table public.manual_bets to authenticated;
grant select on table public.monthly_configs to authenticated;
grant select on table public.ledger_operations to authenticated;
grant select on table public.bankroll_events to authenticated;

revoke all on function public.place_manual_bet(jsonb, text) from public, anon;
revoke all on function public.settle_manual_bet(uuid, text, text) from public, anon;
revoke all on function public.cancel_manual_bet(uuid, text) from public, anon;
revoke all on function public.update_bankroll_settings(uuid, numeric, numeric, boolean) from public, anon;
revoke all on function public.adjust_bankroll(uuid, text, numeric, text, text) from public, anon;
revoke all on function public.update_channel_bankroll_settings(uuid, numeric, integer) from public, anon;
revoke all on function public.upsert_monthly_config(uuid, text, numeric) from public, anon;

grant execute on function public.place_manual_bet(jsonb, text) to authenticated;
grant execute on function public.settle_manual_bet(uuid, text, text) to authenticated;
grant execute on function public.cancel_manual_bet(uuid, text) to authenticated;
grant execute on function public.update_bankroll_settings(uuid, numeric, numeric, boolean) to authenticated;
grant execute on function public.adjust_bankroll(uuid, text, numeric, text, text) to authenticated;
grant execute on function public.update_channel_bankroll_settings(uuid, numeric, integer) to authenticated;
grant execute on function public.upsert_monthly_config(uuid, text, numeric) to authenticated;

commit;
