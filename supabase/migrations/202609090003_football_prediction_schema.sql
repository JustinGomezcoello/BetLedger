-- BetLedger 005: normalized football, context, model and prediction storage.
-- All operational rows belong to the configured owner and are private by RLS.

begin;

create table if not exists public.competition_catalog (
    code text primary key,
    name text not null,
    country_code text,
    competition_type text not null check (competition_type in ('domestic_league', 'uefa_club')),
    football_data_code text,
    api_football_id integer,
    default_rules jsonb not null default '{}'::jsonb,
    source_url text not null
);

insert into public.competition_catalog (
    code, name, country_code, competition_type, football_data_code,
    api_football_id, default_rules, source_url
) values
    ('PL', 'Premier League', 'GB', 'domestic_league', 'PL', 39,
     '{"format":"double_round_robin","clubs":20,"matches_per_club":38,"points":{"win":3,"draw":1,"loss":0},"relegation":{"direct":[18,19,20]},"uefa_places":"conditional_external"}'::jsonb,
     'https://www.premierleague.com/'),
    ('PD', 'La Liga', 'ES', 'domestic_league', 'PD', 140,
     '{"format":"double_round_robin","clubs":20,"matches_per_club":38,"points":{"win":3,"draw":1,"loss":0},"relegation":{"direct":[18,19,20]},"uefa_places":"conditional_external"}'::jsonb,
     'https://www.laliga.com/'),
    ('BL1', 'Bundesliga', 'DE', 'domestic_league', 'BL1', 78,
     '{"format":"double_round_robin","clubs":18,"matches_per_club":34,"points":{"win":3,"draw":1,"loss":0},"relegation":{"playoff":[16],"direct":[17,18]},"uefa_places":"conditional_external"}'::jsonb,
     'https://www.bundesliga.com/'),
    ('UCL', 'UEFA Champions League', null, 'uefa_club', 'CL', 2,
     '{"format":"league_phase_then_knockout","league_phase":{"clubs":36,"matches_per_club":8,"direct_round_of_16":[1,8],"knockout_playoff":[9,24],"eliminated":[25,36]},"knockout":{"two_legs":true,"away_goals":false},"match_market_duration_minutes":90}'::jsonb,
     'https://www.uefa.com/uefachampionsleague/'),
    ('UEL', 'UEFA Europa League', null, 'uefa_club', null, 3,
     '{"format":"league_phase_then_knockout","league_phase":{"clubs":36,"matches_per_club":8,"direct_round_of_16":[1,8],"knockout_playoff":[9,24],"eliminated":[25,36]},"knockout":{"two_legs":true,"away_goals":false},"match_market_duration_minutes":90}'::jsonb,
     'https://www.uefa.com/uefaeuropaleague/'),
    ('UECL', 'UEFA Conference League', null, 'uefa_club', null, 848,
     '{"format":"league_phase_then_knockout","league_phase":{"clubs":36,"matches_per_club":6,"direct_round_of_16":[1,8],"knockout_playoff":[9,24],"eliminated":[25,36]},"knockout":{"two_legs":true,"away_goals":false},"match_market_duration_minutes":90}'::jsonb,
     'https://www.uefa.com/uefaconferenceleague/')
on conflict (code) do update set
    name = excluded.name,
    country_code = excluded.country_code,
    competition_type = excluded.competition_type,
    football_data_code = excluded.football_data_code,
    api_football_id = excluded.api_football_id,
    default_rules = excluded.default_rules,
    source_url = excluded.source_url;

create table if not exists public.competitions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    code text not null references public.competition_catalog(code) on delete restrict,
    name text not null,
    country_code text,
    competition_type text not null check (competition_type in ('domestic_league', 'uefa_club')),
    provider_ids jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (owner_id, code)
);

create table if not exists public.competition_rule_versions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    competition_id uuid not null references public.competitions(id) on delete cascade,
    season text not null,
    version integer not null default 1 check (version > 0),
    rules jsonb not null,
    verification_status text not null default 'provisional'
        check (verification_status in ('provisional', 'official_verified', 'retired')),
    source_url text not null,
    valid_from date not null,
    valid_to date,
    created_at timestamptz not null default now(),
    unique (owner_id, competition_id, season, version),
    check (valid_to is null or valid_to >= valid_from)
);

create table if not exists public.teams (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    name text not null,
    short_name text,
    country_code text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (owner_id, name, country_code)
);

create table if not exists public.team_provider_mappings (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    team_id uuid not null references public.teams(id) on delete cascade,
    provider text not null,
    external_id text not null,
    external_name text,
    mapping_status text not null default 'verified'
        check (mapping_status in ('candidate', 'verified', 'rejected')),
    created_at timestamptz not null default now(),
    unique (owner_id, provider, external_id)
);

create table if not exists public.fixtures (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    competition_id uuid not null references public.competitions(id) on delete restrict,
    rule_version_id uuid references public.competition_rule_versions(id) on delete restrict,
    season text not null,
    home_team_id uuid not null references public.teams(id) on delete restrict,
    away_team_id uuid not null references public.teams(id) on delete restrict,
    kickoff_at timestamptz not null,
    status text not null default 'scheduled'
        check (status in ('scheduled', 'postponed', 'in_progress', 'finished', 'cancelled', 'abandoned')),
    stage text,
    matchday text,
    neutral_venue boolean not null default false,
    home_score integer check (home_score is null or home_score >= 0),
    away_score integer check (away_score is null or away_score >= 0),
    aggregate_context jsonb not null default '{}'::jsonb,
    provider_ids jsonb not null default '{}'::jsonb,
    source_updated_at timestamptz,
    result_available_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (home_team_id <> away_team_id)
);

alter table public.fixtures
    add column if not exists result_available_at timestamptz;

-- Older completed fixtures may not expose a trustworthy provider timestamp.
-- Three hours after kickoff is a conservative result-availability fallback
-- and prevents an early match result leaking into a later kickoff's features.
update public.fixtures
set result_available_at = case
    when source_updated_at between kickoff_at and kickoff_at + interval '14 days'
        then source_updated_at
    else kickoff_at + interval '3 hours'
end
where status = 'finished' and result_available_at is null;

alter table public.fixtures drop constraint if exists fixtures_result_available_after_kickoff;
alter table public.fixtures
    add constraint fixtures_result_available_after_kickoff
    check (result_available_at is null or result_available_at >= kickoff_at) not valid;

create unique index if not exists fixtures_owner_competition_teams_kickoff_idx
    on public.fixtures (owner_id, competition_id, home_team_id, away_team_id, kickoff_at);
create index if not exists fixtures_owner_kickoff_idx
    on public.fixtures (owner_id, kickoff_at);
create index if not exists fixtures_owner_result_available_idx
    on public.fixtures (owner_id, result_available_at)
    where status = 'finished';

create table if not exists public.fixture_provider_mappings (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    provider text not null,
    external_id text not null,
    external_updated_at timestamptz,
    created_at timestamptz not null default now(),
    unique (owner_id, provider, external_id),
    unique (owner_id, fixture_id, provider)
);

create table if not exists public.standings_snapshots (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    competition_id uuid not null references public.competitions(id) on delete cascade,
    rule_version_id uuid references public.competition_rule_versions(id) on delete restrict,
    season text not null,
    team_id uuid not null references public.teams(id) on delete cascade,
    as_of timestamptz not null,
    position integer check (position is null or position > 0),
    played integer not null default 0 check (played >= 0),
    won integer not null default 0 check (won >= 0),
    drawn integer not null default 0 check (drawn >= 0),
    lost integer not null default 0 check (lost >= 0),
    goals_for integer not null default 0,
    goals_against integer not null default 0,
    points numeric not null default 0,
    objectives jsonb not null default '{}'::jsonb,
    source_provider text not null,
    source_payload_id uuid,
    created_at timestamptz not null default now(),
    unique (owner_id, competition_id, season, team_id, as_of)
);

create table if not exists public.context_observations (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    team_id uuid references public.teams(id) on delete cascade,
    entity_type text not null default 'team'
        check (entity_type in ('competition', 'fixture', 'team', 'player', 'coach')),
    entity_ref text,
    observation_type text not null
        check (observation_type in (
            'objective_status', 'injury', 'suspension', 'return', 'rotation',
            'coach_comment', 'schedule_congestion', 'rest', 'other'
        )),
    evidence_summary text not null check (char_length(evidence_summary) between 1 and 1000),
    source_tier text not null
        check (source_tier in ('official', 'structured', 'press', 'community', 'rumor')),
    confidence numeric not null default 0.5 check (confidence between 0 and 1),
    source_url text not null,
    source_hash text not null,
    published_at timestamptz,
    observed_at timestamptz not null default now(),
    fetched_at timestamptz not null default now(),
    valid_from timestamptz,
    expires_at timestamptz,
    review_status text not null default 'pending'
        check (review_status in ('pending', 'approved', 'corrected', 'rejected')),
    initial_review_status text not null default 'pending'
        check (initial_review_status in ('pending', 'approved')),
    is_conflicted boolean not null default false,
    conflict_group text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (owner_id, fixture_id, source_hash),
    check (expires_at is null or valid_from is null or expires_at >= valid_from)
);

alter table public.context_observations
    add column if not exists initial_review_status text not null default 'pending'
    check (initial_review_status in ('pending', 'approved'));

-- Structured provider observations were approved at ingestion before this
-- append-only origin field existed. Preserve that origin on an incremental
-- deployment without changing the current human review decision.
update public.context_observations
set initial_review_status = 'approved'
where source_tier = 'structured'
  and initial_review_status = 'pending'
  and coalesce(metadata ->> 'provider', '') <> '';

create index if not exists context_observations_review_idx
    on public.context_observations (owner_id, review_status, fetched_at desc);
create index if not exists context_observations_fixture_idx
    on public.context_observations (fixture_id, observed_at desc);

create table if not exists public.context_reviews (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    observation_id uuid not null references public.context_observations(id) on delete cascade,
    decision text not null check (decision in ('approved', 'corrected', 'rejected')),
    idempotency_key text not null check (char_length(idempotency_key) between 8 and 180),
    corrected_summary text check (
        corrected_summary is null or char_length(corrected_summary) between 1 and 1000
    ),
    scenario_adjustment jsonb not null default '{}'::jsonb,
    reviewed_at timestamptz not null default now(),
    unique (owner_id, idempotency_key)
);

create index if not exists context_reviews_observation_idx
    on public.context_reviews (observation_id, reviewed_at desc);

create table if not exists public.player_availability_snapshots (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    team_id uuid not null references public.teams(id) on delete cascade,
    player_external_ref text not null,
    player_name text not null,
    status text not null
        check (status in ('available', 'doubtful', 'injured', 'suspended', 'returning', 'unknown')),
    probability_available numeric check (probability_available between 0 and 1),
    source_observation_id uuid references public.context_observations(id) on delete set null,
    as_of timestamptz not null,
    created_at timestamptz not null default now(),
    unique (owner_id, fixture_id, player_external_ref, as_of)
);

create table if not exists public.lineups (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    team_id uuid not null references public.teams(id) on delete cascade,
    lineup_type text not null check (lineup_type in ('scenario', 'confirmed')),
    scenario_probability numeric check (scenario_probability between 0 and 1),
    formation text,
    source_tier text not null check (source_tier in ('official', 'structured', 'press', 'community')),
    observed_at timestamptz not null,
    source_url text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (owner_id, fixture_id, team_id, lineup_type, observed_at)
);

create table if not exists public.lineup_players (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    lineup_id uuid not null references public.lineups(id) on delete cascade,
    player_external_ref text not null,
    player_name text not null,
    position text,
    is_starter boolean not null default true,
    expected_minutes numeric check (expected_minutes is null or expected_minutes between 0 and 130),
    strength_delta numeric,
    created_at timestamptz not null default now(),
    unique (lineup_id, player_external_ref)
);

create table if not exists public.odds_snapshots (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    provider text not null,
    bookmaker text not null,
    market text not null check (market in ('1x2', 'over_under_2_5', 'btts')),
    outcome text not null check (outcome in ('home', 'draw', 'away', 'over', 'under', 'yes', 'no')),
    decimal_odds numeric not null check (decimal_odds > 1 and decimal_odds <= 1000),
    observed_at timestamptz not null,
    is_closing boolean not null default false,
    created_at timestamptz not null default now(),
    unique (owner_id, fixture_id, provider, bookmaker, market, outcome, observed_at)
);

create index if not exists odds_snapshots_fixture_market_idx
    on public.odds_snapshots (fixture_id, market, observed_at desc);

create table if not exists public.provider_payloads (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    provider text not null,
    endpoint text not null,
    fixture_id uuid references public.fixtures(id) on delete cascade,
    request_fingerprint text not null,
    fetched_at timestamptz not null default now(),
    http_status integer not null,
    is_stale boolean not null default false,
    data_state text not null default 'complete'
        check (data_state in ('complete', 'empty_unverified', 'error', 'stale')),
    payload jsonb not null,
    payload_hash text not null,
    unique (owner_id, provider, request_fingerprint, payload_hash)
);

alter table public.provider_payloads
    add column if not exists data_state text not null default 'complete'
    check (data_state in ('complete', 'empty_unverified', 'error', 'stale'));

update public.provider_payloads
set data_state = 'error'
where http_status <> 200 and data_state = 'complete';

update public.provider_payloads
set data_state = 'empty_unverified'
where provider = 'api_football'
  and http_status = 200
  and data_state = 'complete'
  and jsonb_typeof(payload -> 'response') = 'array'
  and jsonb_array_length(payload -> 'response') = 0;

create table if not exists public.context_feature_snapshots (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    horizon text not null check (horizon in ('t24h', 't6h', 'official_lineup')),
    data_cutoff timestamptz not null,
    input_hash text check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
    generation_hash text check (generation_hash is null or generation_hash ~ '^[0-9a-f]{64}$'),
    features jsonb not null,
    evidence_ids uuid[] not null default '{}'::uuid[],
    has_material_conflict boolean not null default false,
    data_quality jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (owner_id, fixture_id, horizon, data_cutoff)
);

alter table public.context_feature_snapshots
    add column if not exists input_hash text
    check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$');
alter table public.context_feature_snapshots
    add column if not exists generation_hash text
    check (generation_hash is null or generation_hash ~ '^[0-9a-f]{64}$');
drop index if exists public.context_feature_snapshots_input_hash_idx;
create unique index if not exists context_feature_snapshots_generation_hash_idx
    on public.context_feature_snapshots (owner_id, fixture_id, horizon, generation_hash)
    where generation_hash is not null;

create table if not exists public.model_versions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    version text not null,
    model_family text not null check (model_family in ('poisson', 'dixon_coles_elo', 'gradient_boosting')),
    status text not null default 'shadow'
        check (status in ('baseline', 'shadow', 'champion', 'retired')),
    training_cutoff timestamptz not null,
    artifact_sha256 text not null,
    parameters jsonb not null,
    metrics jsonb not null default '{}'::jsonb,
    feature_schema_version text not null,
    created_at timestamptz not null default now(),
    promoted_at timestamptz,
    unique (owner_id, version)
);

create unique index if not exists model_versions_single_champion_idx
    on public.model_versions (owner_id)
    where status = 'champion';

create table if not exists public.competition_recommendation_activation (
    owner_id uuid not null references auth.users(id) on delete restrict,
    competition_id uuid not null references public.competitions(id) on delete cascade,
    enabled boolean not null default false,
    shadow_started_at timestamptz not null default now(),
    evaluated_at timestamptz,
    completed_fixture_count integer not null default 0 check (completed_fixture_count >= 0),
    central_coverage numeric not null default 0 check (central_coverage between 0 and 1),
    official_lineup_coverage numeric not null default 0 check (official_lineup_coverage between 0 and 1),
    validation_report jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (owner_id, competition_id),
    check (
        not enabled or (
            completed_fixture_count >= 100
            and central_coverage >= 0.99
            and official_lineup_coverage >= 0.80
            and evaluated_at is not null
            and evaluated_at >= shadow_started_at + interval '30 days'
        )
    )
);

create table if not exists public.training_runs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    model_version_id uuid references public.model_versions(id) on delete set null,
    trigger_type text not null check (trigger_type in ('scheduled', 'manual', 'backfill')),
    status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
    data_cutoff timestamptz not null,
    last_result_at timestamptz,
    metrics jsonb not null default '{}'::jsonb,
    error_code text,
    error_message text,
    started_at timestamptz,
    completed_at timestamptz,
    idempotency_key text,
    created_at timestamptz not null default now()
);

create unique index if not exists training_runs_owner_idempotency_idx
    on public.training_runs (owner_id, idempotency_key)
    ;

create table if not exists public.prediction_snapshots (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    model_version_id uuid not null references public.model_versions(id) on delete restrict,
    feature_snapshot_id uuid references public.context_feature_snapshots(id) on delete restrict,
    market text not null check (market in ('1x2', 'over_under_2_5', 'btts')),
    outcome text not null check (outcome in ('home', 'draw', 'away', 'over', 'under', 'yes', 'no')),
    horizon text not null check (horizon in ('t24h', 't6h', 'official_lineup')),
    lambda_home numeric not null check (lambda_home > 0 and lambda_home <= 10),
    lambda_away numeric not null check (lambda_away > 0 and lambda_away <= 10),
    probability_base numeric not null check (probability_base between 0 and 1),
    probability_contextual numeric not null check (probability_contextual between 0 and 1),
    interval_low numeric not null check (interval_low between 0 and 1),
    interval_high numeric not null check (interval_high between 0 and 1),
    fair_odds numeric check (fair_odds is null or fair_odds > 1),
    offered_odds numeric check (offered_odds is null or offered_odds > 1),
    edge numeric,
    lower_bound_edge numeric,
    probability_positive_ev numeric check (probability_positive_ev between 0 and 1),
    impacts jsonb not null default '{}'::jsonb,
    score_distribution jsonb not null default '{}'::jsonb,
    qualification_probabilities jsonb not null default '{}'::jsonb,
    reasons jsonb not null default '[]'::jsonb,
    data_cutoff timestamptz not null,
    input_hash text check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
    generation_hash text check (generation_hash is null or generation_hash ~ '^[0-9a-f]{64}$'),
    odds_observed_at timestamptz,
    context_conflict boolean not null default false,
    data_quality jsonb not null default '{}'::jsonb,
    decision text not null check (decision in ('paper_candidate', 'no_bet', 'informational')),
    created_at timestamptz not null default now(),
    check (interval_low <= probability_contextual and probability_contextual <= interval_high),
    check (
        (market = '1x2' and outcome in ('home', 'draw', 'away'))
        or (market = 'over_under_2_5' and outcome in ('over', 'under'))
        or (market = 'btts' and outcome in ('yes', 'no'))
    ),
    unique (owner_id, fixture_id, model_version_id, horizon, market, outcome, data_cutoff)
);

alter table public.prediction_snapshots
    add column if not exists input_hash text
    check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$');
alter table public.prediction_snapshots
    add column if not exists generation_hash text
    check (generation_hash is null or generation_hash ~ '^[0-9a-f]{64}$');
drop index if exists public.prediction_snapshots_input_hash_idx;
create unique index if not exists prediction_snapshots_generation_hash_idx
    on public.prediction_snapshots (
        owner_id, fixture_id, model_version_id, horizon, market, outcome, generation_hash
    ) where generation_hash is not null;

create index if not exists prediction_snapshots_fixture_created_idx
    on public.prediction_snapshots (fixture_id, created_at desc);

create table if not exists public.recommendations (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    prediction_snapshot_id uuid not null references public.prediction_snapshots(id) on delete restrict,
    market text not null check (market in ('1x2', 'over_under_2_5')),
    outcome text not null check (outcome in ('home', 'draw', 'away', 'over', 'under')),
    selection text not null,
    offered_odds numeric not null check (offered_odds > 1),
    fair_odds numeric not null check (fair_odds > 1),
    edge numeric not null,
    lower_bound_edge numeric not null,
    probability_positive_ev numeric not null check (probability_positive_ev between 0 and 1),
    decision text not null check (decision in ('paper_candidate', 'no_bet', 'informational')),
    status text not null default 'available'
        check (status in ('available', 'registered', 'expired', 'dismissed')),
    expires_at timestamptz not null,
    registered_bet_id uuid references public.manual_bets(id) on delete restrict,
    registration_idempotency_key text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (prediction_snapshot_id),
    unique (owner_id, registration_idempotency_key),
    check (
        (market = '1x2' and outcome in ('home', 'draw', 'away'))
        or (market = 'over_under_2_5' and outcome in ('over', 'under'))
    ),
    check (
        status <> 'registered'
        or (registered_bet_id is not null and registration_idempotency_key is not null)
    )
);

create unique index if not exists recommendations_one_available_candidate_idx
    on public.recommendations (owner_id, fixture_id)
    where decision = 'paper_candidate' and status = 'available';

drop trigger if exists recommendations_touch_updated_at on public.recommendations;
create trigger recommendations_touch_updated_at
before update on public.recommendations
for each row execute function private.touch_updated_at();

-- T-24h, T-6h and official-XI snapshots are audit records. A later run writes
-- a new cutoff instead of changing or deleting the evidence/model decision.
create or replace function private.reject_immutable_prediction_snapshot_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
    raise exception 'prediction snapshots are immutable; create a new snapshot'
        using errcode = '55000';
end;
$$;

revoke all on function private.reject_immutable_prediction_snapshot_change()
    from public, anon, authenticated;

drop trigger if exists context_feature_snapshots_reject_update_delete
    on public.context_feature_snapshots;
create trigger context_feature_snapshots_reject_update_delete
before update or delete on public.context_feature_snapshots
for each row execute function private.reject_immutable_prediction_snapshot_change();

drop trigger if exists prediction_snapshots_reject_update_delete
    on public.prediction_snapshots;
create trigger prediction_snapshots_reject_update_delete
before update or delete on public.prediction_snapshots
for each row execute function private.reject_immutable_prediction_snapshot_change();

alter table public.manual_bets
    add column if not exists recommendation_id uuid references public.recommendations(id) on delete restrict;
create unique index if not exists manual_bets_recommendation_idx
    on public.manual_bets (recommendation_id)
    where recommendation_id is not null;

create table if not exists public.sync_requests (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    scope text not null check (scope in ('all', 'competition', 'date', 'fixture', 'lineup_window')),
    fixture_id uuid references public.fixtures(id) on delete cascade,
    competition_id uuid references public.competitions(id) on delete cascade,
    requested_date date,
    requested_by text not null check (requested_by in ('owner', 'schedule', 'system')),
    priority smallint not null default 5 check (priority between 1 and 10),
    idempotency_key text not null,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'skipped')),
    created_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    unique (owner_id, idempotency_key)
);

create table if not exists public.sync_runs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete restrict,
    request_id uuid references public.sync_requests(id) on delete set null,
    provider text not null,
    status text not null check (status in ('running', 'succeeded', 'partial', 'failed', 'skipped')),
    endpoints jsonb not null default '[]'::jsonb,
    calls_used integer not null default 0 check (calls_used >= 0),
    records_written integer not null default 0 check (records_written >= 0),
    error_code text,
    error_message text,
    started_at timestamptz not null default now(),
    completed_at timestamptz
);

create table if not exists public.api_usage_daily (
    owner_id uuid not null references auth.users(id) on delete restrict,
    provider text not null,
    usage_date date not null default (now() at time zone 'utc')::date,
    used_count integer not null default 0 check (used_count >= 0),
    daily_limit integer not null check (daily_limit > 0),
    endpoint_breakdown jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (owner_id, provider, usage_date)
);

create table if not exists public.fixture_provider_counters (
    owner_id uuid not null references auth.users(id) on delete restrict,
    fixture_id uuid not null references public.fixtures(id) on delete cascade,
    provider text not null,
    counter_name text not null,
    used_count integer not null default 0 check (used_count >= 0),
    updated_at timestamptz not null default now(),
    primary key (owner_id, fixture_id, provider, counter_name)
);

-- Seed the six enabled competitions and provisional 2026-27 rule snapshots for
-- an owner. Provisional matters: exact objective claims remain blocked until the
-- corresponding source is marked official_verified.
create or replace function private.seed_owner_football_defaults(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
    if not exists (
        select 1 from public.app_members where user_id = p_owner_id and role = 'owner'
    ) then
        raise exception 'configured owner required' using errcode = '42501';
    end if;

    insert into public.competitions (
        owner_id, code, name, country_code, competition_type, provider_ids
    )
    select p_owner_id, c.code, c.name, c.country_code, c.competition_type,
           jsonb_strip_nulls(jsonb_build_object(
               'football_data', c.football_data_code,
               'api_football', c.api_football_id
           ))
    from public.competition_catalog c
    on conflict (owner_id, code) do update set
        name = excluded.name,
        country_code = excluded.country_code,
        competition_type = excluded.competition_type,
        provider_ids = excluded.provider_ids;

    insert into public.competition_rule_versions (
        owner_id, competition_id, season, version, rules,
        verification_status, source_url, valid_from, valid_to
    )
    select p_owner_id, c.id, '2026-27', 1, catalog.default_rules,
           'provisional', catalog.source_url, date '2026-07-01', date '2027-06-30'
    from public.competitions c
    join public.competition_catalog catalog on catalog.code = c.code
    where c.owner_id = p_owner_id
    on conflict (owner_id, competition_id, season, version) do nothing;

    -- A transparent compatibility baseline is available immediately. It is
    -- deliberately not a champion, so it can publish probabilities but can
    -- never create a paper candidate until an out-of-sample model is promoted.
    insert into public.model_versions (
        owner_id, version, model_family, status, training_cutoff,
        artifact_sha256, parameters, metrics, feature_schema_version
    ) values (
        p_owner_id,
        'poisson-baseline-v1',
        'poisson',
        'baseline',
        timestamptz '1970-01-01 00:00:00+00',
        '1d105d8f5c7794ff69608716253836f248aadb026e13880b7db76f5d798c1e88',
        '{"max_goals":10,"home_lambda_prior":1.55,"away_lambda_prior":1.25,"smoothing_matches":5,"context_enabled":false}'::jsonb,
        '{"validation":"compatibility_only","recommendations_enabled":false}'::jsonb,
        'football-context-v1'
    )
    on conflict (owner_id, version) do nothing;

    insert into public.competition_recommendation_activation (owner_id, competition_id)
    select p_owner_id, id
    from public.competitions
    where owner_id = p_owner_id
    on conflict (owner_id, competition_id) do nothing;
end;
$$;

revoke all on function private.seed_owner_football_defaults(uuid)
    from public, anon, authenticated;

create or replace function private.seed_owner_football_defaults_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
    perform private.seed_owner_football_defaults(new.user_id);
    return new;
end;
$$;

drop trigger if exists app_members_seed_football_defaults on public.app_members;
create trigger app_members_seed_football_defaults
after insert on public.app_members
for each row execute function private.seed_owner_football_defaults_trigger();

do $$
declare
    v_owner_id uuid;
begin
    for v_owner_id in select user_id from public.app_members where role = 'owner' loop
        perform private.seed_owner_football_defaults(v_owner_id);
    end loop;
end;
$$;

create or replace function public.review_context_observation(
    p_observation_id uuid,
    p_decision text,
    p_idempotency_key text,
    p_corrected_summary text default null,
    p_scenario_adjustment jsonb default '{}'::jsonb
)
returns public.context_observations
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_observation public.context_observations%rowtype;
    v_existing_review public.context_reviews%rowtype;
    v_previous_review_status text;
begin
    if p_decision not in ('approved', 'corrected', 'rejected') then
        raise exception 'invalid review decision' using errcode = '22023';
    end if;
    if p_decision = 'corrected'
       and length(btrim(coalesce(p_corrected_summary, ''))) = 0 then
        raise exception 'corrected summary is required' using errcode = '22023';
    end if;
    if jsonb_typeof(coalesce(p_scenario_adjustment, '{}'::jsonb)) <> 'object' then
        raise exception 'scenario adjustment must be an object' using errcode = '22023';
    end if;
    if char_length(coalesce(p_idempotency_key, '')) not between 8 and 180 then
        raise exception 'invalid idempotency key' using errcode = '22023';
    end if;

    select * into v_existing_review
    from public.context_reviews
    where owner_id = v_owner_id and idempotency_key = p_idempotency_key;
    if found then
        if v_existing_review.observation_id <> p_observation_id
           or v_existing_review.decision <> p_decision
           or (
                p_decision = 'corrected'
                and coalesce(v_existing_review.corrected_summary, '')
                    <> btrim(coalesce(p_corrected_summary, ''))
           )
           or (p_decision <> 'corrected' and v_existing_review.corrected_summary is not null)
           or v_existing_review.scenario_adjustment
              <> coalesce(p_scenario_adjustment, '{}'::jsonb) then
            raise exception 'idempotency key reused with different review input'
                using errcode = '22023';
        end if;
        select * into strict v_observation
        from public.context_observations
        where id = p_observation_id and owner_id = v_owner_id;
        return v_observation;
    end if;

    select * into v_observation
    from public.context_observations
    where id = p_observation_id and owner_id = v_owner_id
    for update;
    if not found then
        raise exception 'context observation not found' using errcode = 'P0002';
    end if;
    v_previous_review_status := v_observation.review_status;

    insert into public.context_reviews (
        owner_id, observation_id, decision, idempotency_key, corrected_summary, scenario_adjustment
    ) values (
        v_owner_id, p_observation_id, p_decision, p_idempotency_key,
        case when p_decision = 'corrected' then btrim(p_corrected_summary) else null end,
        coalesce(p_scenario_adjustment, '{}'::jsonb)
    );

    update public.context_observations
    set review_status = p_decision
    where id = p_observation_id
    returning * into v_observation;

    if v_observation.conflict_group is not null then
        update public.context_observations candidate
        set is_conflicted = (
            exists (
                select 1 from public.context_observations active_return
                where active_return.owner_id = v_owner_id
                  and active_return.conflict_group = v_observation.conflict_group
                  and active_return.review_status <> 'rejected'
                  and active_return.observation_type = 'return'
            )
            and exists (
                select 1 from public.context_observations active_absence
                where active_absence.owner_id = v_owner_id
                  and active_absence.conflict_group = v_observation.conflict_group
                  and active_absence.review_status <> 'rejected'
                  and active_absence.observation_type in ('injury', 'suspension')
            )
        )
        where candidate.owner_id = v_owner_id
          and candidate.conflict_group = v_observation.conflict_group;

        select * into strict v_observation
        from public.context_observations
        where id = p_observation_id and owner_id = v_owner_id;
    end if;

    if v_previous_review_status in ('approved', 'corrected')
       or p_decision in ('approved', 'corrected') then
        update public.recommendations
        set status = 'expired'
        where owner_id = v_owner_id
          and fixture_id = v_observation.fixture_id
          and status = 'available';
    end if;
    return v_observation;
end;
$$;

-- Publish or clear the one current paper recommendation for a fixture. The
-- Edge runtime may retry after any network boundary, so this reconciliation is
-- derived exclusively from immutable snapshot rows and is safe to repeat.
create or replace function public.reconcile_fixture_recommendation(
    p_owner_id uuid,
    p_anchor_snapshot_id uuid,
    p_candidate_snapshot_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_anchor public.prediction_snapshots%rowtype;
    v_candidate public.prediction_snapshots%rowtype;
    v_existing public.recommendations%rowtype;
    v_latest_cutoff timestamptz;
    v_selection text;
begin
    if not public.is_app_owner(p_owner_id) then
        raise exception 'configured owner required' using errcode = '42501';
    end if;

    select * into v_anchor
    from public.prediction_snapshots
    where id = p_anchor_snapshot_id and owner_id = p_owner_id;
    if not found then
        raise exception 'anchor prediction snapshot not found' using errcode = 'P0002';
    end if;

    perform pg_advisory_xact_lock(
        hashtextextended(p_owner_id::text || ':' || v_anchor.fixture_id::text, 0)
    );

    select max(data_cutoff) into v_latest_cutoff
    from public.prediction_snapshots
    where owner_id = p_owner_id and fixture_id = v_anchor.fixture_id;
    if v_anchor.data_cutoff < v_latest_cutoff then
        return jsonb_build_object('status', 'stale_generation');
    end if;

    if p_candidate_snapshot_id is not null then
        select * into v_candidate
        from public.prediction_snapshots
        where id = p_candidate_snapshot_id
          and owner_id = p_owner_id
          and fixture_id = v_anchor.fixture_id
          and data_cutoff = v_anchor.data_cutoff;
        if not found then
            raise exception 'candidate prediction snapshot not found in anchor generation'
                using errcode = '22023';
        end if;
        if v_candidate.decision <> 'paper_candidate'
           or v_candidate.market not in ('1x2', 'over_under_2_5')
           or v_candidate.offered_odds is null
           or v_candidate.fair_odds is null
           or v_candidate.lower_bound_edge < 0.02
           or v_candidate.probability_positive_ev < 0.90
           or v_candidate.context_conflict
           or not exists (
                select 1 from public.model_versions model
                where model.id = v_candidate.model_version_id
                  and model.owner_id = p_owner_id
                  and model.status = 'champion'
                  and model.model_family = 'dixon_coles_elo'
                  and model.feature_schema_version = 'football-result-only-v1'
                  and model.parameters ->> 'inference_contract_version' = 'football-probability-v1'
                  and model.parameters ->> 'uncertainty_method' = 'poisson_exposure_qmc_v1'
           )
           or not exists (
                select 1
                from public.fixtures fixture
                join public.competition_recommendation_activation activation
                  on activation.owner_id = fixture.owner_id
                 and activation.competition_id = fixture.competition_id
                where fixture.id = v_candidate.fixture_id
                  and fixture.owner_id = p_owner_id
                  and fixture.status in ('scheduled', 'postponed')
                  and fixture.kickoff_at > now()
                  and activation.enabled
           )
           or not exists (
                select 1 from public.context_feature_snapshots feature
                where feature.id = v_candidate.feature_snapshot_id
                  and feature.owner_id = p_owner_id
                  and coalesce((feature.features ->> 'official_lineup')::boolean, false)
                  and not feature.has_material_conflict
           ) then
            raise exception 'snapshot does not satisfy paper candidate gates'
                using errcode = '22023';
        end if;
    end if;

    update public.recommendations recommendation
    set status = 'expired'
    from public.prediction_snapshots snapshot
    where recommendation.owner_id = p_owner_id
      and recommendation.fixture_id = v_anchor.fixture_id
      and recommendation.status = 'available'
      and recommendation.prediction_snapshot_id = snapshot.id
      and snapshot.data_cutoff <= v_anchor.data_cutoff
      and (
          p_candidate_snapshot_id is null
          or recommendation.prediction_snapshot_id <> p_candidate_snapshot_id
      );

    if p_candidate_snapshot_id is null then
        return jsonb_build_object('status', 'no_candidate');
    end if;
    if v_candidate.odds_observed_at is null
       or v_candidate.odds_observed_at < now() - interval '30 minutes' then
        return jsonb_build_object('status', 'odds_stale');
    end if;

    select * into v_existing
    from public.recommendations
    where owner_id = p_owner_id
      and prediction_snapshot_id = p_candidate_snapshot_id;
    if found then
        return jsonb_build_object(
            'status', 'existing',
            'recommendation_id', v_existing.id,
            'recommendation_status', v_existing.status
        );
    end if;

    v_selection := case
        when v_candidate.market = '1x2' and v_candidate.outcome = 'home' then 'Gana local'
        when v_candidate.market = '1x2' and v_candidate.outcome = 'draw' then 'Empate'
        when v_candidate.market = '1x2' and v_candidate.outcome = 'away' then 'Gana visitante'
        when v_candidate.market = 'over_under_2_5' and v_candidate.outcome = 'over' then 'Más de 2.5 goles'
        when v_candidate.market = 'over_under_2_5' and v_candidate.outcome = 'under' then 'Menos de 2.5 goles'
        else null
    end;
    if v_selection is null then
        raise exception 'unsupported recommendation selection' using errcode = '22023';
    end if;

    insert into public.recommendations (
        owner_id, fixture_id, prediction_snapshot_id, market, outcome,
        selection, offered_odds, fair_odds, edge, lower_bound_edge,
        probability_positive_ev, decision, expires_at
    ) values (
        p_owner_id, v_candidate.fixture_id, v_candidate.id,
        v_candidate.market, v_candidate.outcome, v_selection,
        v_candidate.offered_odds, v_candidate.fair_odds, v_candidate.edge,
        v_candidate.lower_bound_edge, v_candidate.probability_positive_ev,
        'paper_candidate', v_candidate.odds_observed_at + interval '30 minutes'
    )
    on conflict (prediction_snapshot_id) do nothing
    returning * into v_existing;

    if not found then
        select * into strict v_existing
        from public.recommendations
        where owner_id = p_owner_id
          and prediction_snapshot_id = p_candidate_snapshot_id;
    end if;
    return jsonb_build_object(
        'status', 'published',
        'recommendation_id', v_existing.id,
        'recommendation_status', v_existing.status
    );
end;
$$;

create or replace function public.register_recommendation(
    p_recommendation_id uuid,
    p_idempotency_key text,
    p_bet_input jsonb default '{}'::jsonb
)
returns public.manual_bets
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
    v_owner_id uuid := private.require_owner_id();
    v_recommendation public.recommendations%rowtype;
    v_prediction public.prediction_snapshots%rowtype;
    v_bet public.manual_bets%rowtype;
    v_bet_input jsonb;
begin
    if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
       or length(p_idempotency_key) > 140 then
        raise exception 'idempotency key must contain 8 to 140 characters'
            using errcode = '22023';
    end if;

    select * into v_recommendation
    from public.recommendations
    where id = p_recommendation_id and owner_id = v_owner_id
    for update;
    if not found then
        raise exception 'recommendation not found' using errcode = 'P0002';
    end if;

    if v_recommendation.status = 'registered' then
        if v_recommendation.registration_idempotency_key <> p_idempotency_key
           or v_recommendation.registered_bet_id is null then
            raise exception 'recommendation was already registered'
                using errcode = '23505';
        end if;
        select * into strict v_bet from public.manual_bets
        where id = v_recommendation.registered_bet_id and owner_id = v_owner_id;
        return v_bet;
    end if;

    select * into strict v_prediction
    from public.prediction_snapshots
    where id = v_recommendation.prediction_snapshot_id
      and owner_id = v_owner_id
    for share;

    if v_prediction.fixture_id <> v_recommendation.fixture_id
       or v_prediction.market <> v_recommendation.market
       or v_prediction.outcome <> v_recommendation.outcome
       or v_prediction.offered_odds is distinct from v_recommendation.offered_odds
       or v_prediction.fair_odds is distinct from v_recommendation.fair_odds then
        raise exception 'recommendation does not match its immutable prediction snapshot'
            using errcode = '23514';
    end if;
    if exists (
        select 1
        from public.prediction_snapshots newer
        where newer.owner_id = v_owner_id
          and newer.fixture_id = v_prediction.fixture_id
          and newer.data_cutoff > v_prediction.data_cutoff
    ) then
        raise exception 'recommendation was superseded by a newer prediction'
            using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.model_versions mv
        where mv.id = v_prediction.model_version_id
          and mv.owner_id = v_owner_id
          and mv.status = 'champion'
          and mv.model_family = 'dixon_coles_elo'
          and mv.feature_schema_version = 'football-result-only-v1'
          and mv.parameters ->> 'inference_contract_version' = 'football-probability-v1'
          and mv.parameters ->> 'uncertainty_method' = 'poisson_exposure_qmc_v1'
    ) then
        raise exception 'prediction model is not the active champion' using errcode = '22023';
    end if;
    if not exists (
        select 1
        from public.fixtures f
        join public.competition_recommendation_activation a
          on a.competition_id = f.competition_id
         and a.owner_id = f.owner_id
        where f.id = v_prediction.fixture_id
          and f.owner_id = v_owner_id
          and f.status in ('scheduled', 'postponed')
          and f.kickoff_at > now()
          and a.enabled
    ) then
        raise exception 'paper recommendations are not activated or fixture is not pre-match'
            using errcode = '22023';
    end if;

    if v_recommendation.status <> 'available'
       or v_recommendation.decision <> 'paper_candidate'
       or v_prediction.decision <> 'paper_candidate' then
        raise exception 'recommendation is not an available paper candidate'
            using errcode = '22023';
    end if;
    if v_prediction.horizon <> 'official_lineup' then
        raise exception 'official lineup is required' using errcode = '22023';
    end if;
    if v_prediction.context_conflict then
        raise exception 'material context conflict blocks registration' using errcode = '22023';
    end if;
    if exists (
        select 1
        from public.context_observations observation
        where observation.owner_id = v_owner_id
          and observation.fixture_id = v_prediction.fixture_id
          and (
              observation.review_status in ('approved', 'corrected')
              or (
                  observation.review_status = 'pending'
                  and observation.source_tier in ('official', 'structured', 'press')
                  and observation.observation_type <> 'other'
              )
          )
          and greatest(observation.observed_at, observation.fetched_at) > v_prediction.data_cutoff
    ) or exists (
        select 1
        from public.context_reviews review
        join public.context_observations observation on observation.id = review.observation_id
        where review.owner_id = v_owner_id
          and observation.fixture_id = v_prediction.fixture_id
          and review.reviewed_at > v_prediction.data_cutoff
    ) or exists (
        select 1 from public.lineups lineup
        where lineup.owner_id = v_owner_id
          and lineup.fixture_id = v_prediction.fixture_id
          and lineup.observed_at > v_prediction.data_cutoff
    ) or exists (
        select 1 from public.player_availability_snapshots availability
        where availability.owner_id = v_owner_id
          and availability.fixture_id = v_prediction.fixture_id
          and availability.as_of > v_prediction.data_cutoff
    ) or exists (
        select 1
        from public.standings_snapshots standing
        join public.fixtures predicted_fixture
          on predicted_fixture.id = v_prediction.fixture_id
         and predicted_fixture.owner_id = standing.owner_id
         and predicted_fixture.competition_id = standing.competition_id
         and predicted_fixture.season = standing.season
        where standing.owner_id = v_owner_id
          and standing.team_id in (predicted_fixture.home_team_id, predicted_fixture.away_team_id)
          and standing.as_of > v_prediction.data_cutoff
    ) or exists (
        select 1
        from public.fixtures result_fixture
        join public.fixtures predicted_fixture
          on predicted_fixture.id = v_prediction.fixture_id
         and predicted_fixture.owner_id = result_fixture.owner_id
         and predicted_fixture.competition_id = result_fixture.competition_id
        where result_fixture.owner_id = v_owner_id
          and result_fixture.status = 'finished'
          and result_fixture.kickoff_at < predicted_fixture.kickoff_at
          and result_fixture.result_available_at > v_prediction.data_cutoff
    ) then
        raise exception 'new pre-match information requires a fresh prediction'
            using errcode = '22023';
    end if;
    if exists (
        select 1
        from (
            select distinct on (payload.endpoint)
                payload.endpoint, payload.http_status, payload.is_stale, payload.data_state
            from public.provider_payloads payload
            where payload.owner_id = v_owner_id
              and payload.fixture_id = v_prediction.fixture_id
              and payload.provider = 'api_football'
              and payload.endpoint in ('fixtures', 'injuries', 'odds', 'fixtures/lineups')
            order by payload.endpoint, payload.fetched_at desc, payload.id desc
        ) latest
        where latest.is_stale or latest.http_status <> 200 or latest.data_state <> 'complete'
    ) or (
        exists (
            select 1 from public.fixtures mapped_fixture
            where mapped_fixture.id = v_prediction.fixture_id
              and mapped_fixture.owner_id = v_owner_id
              and coalesce(mapped_fixture.provider_ids ->> 'api_football', '') <> ''
        )
        and (
            select count(distinct payload.endpoint)
            from public.provider_payloads payload
            where payload.owner_id = v_owner_id
              and payload.fixture_id = v_prediction.fixture_id
              and payload.provider = 'api_football'
              and payload.endpoint in ('fixtures', 'injuries', 'odds', 'fixtures/lineups')
        ) < 4
    ) then
        raise exception 'provider data is stale; refresh before registration'
            using errcode = '22023';
    end if;
    if v_prediction.odds_observed_at is null
       or v_prediction.odds_observed_at < now() - interval '30 minutes'
       or v_recommendation.expires_at < now() then
        raise exception 'recommendation odds are stale' using errcode = '22023';
    end if;
    if coalesce(v_recommendation.lower_bound_edge, -1) < 0.02
       or coalesce(v_recommendation.probability_positive_ev, 0) < 0.90 then
        raise exception 'recommendation no longer meets conservative value gates'
            using errcode = '22023';
    end if;

    -- Odds and selection always come from the immutable recommendation. The
    -- owner supplies only ledger choices such as profile, channel and stake.
    v_bet_input := coalesce(p_bet_input, '{}'::jsonb) || jsonb_build_object(
        'bet_type', 'single',
        'category', 'Football',
        'selection', v_recommendation.selection,
        'description', 'Paper candidate ' || v_recommendation.market || ':' || v_recommendation.outcome,
        'odds', v_recommendation.offered_odds,
        'is_tracking', coalesce((p_bet_input->>'is_tracking')::boolean, false)
    );

    v_bet := public.place_manual_bet(
        v_bet_input,
        left('recommendation:' || v_recommendation.id::text || ':' || p_idempotency_key, 160)
    );

    update public.manual_bets
    set recommendation_id = v_recommendation.id
    where id = v_bet.id
    returning * into v_bet;

    update public.recommendations
    set status = 'registered',
        registered_bet_id = v_bet.id,
        registration_idempotency_key = p_idempotency_key
    where id = v_recommendation.id;

    return v_bet;
end;
$$;

create or replace function public.reserve_api_calls(
    p_owner_id uuid,
    p_provider text,
    p_endpoint text,
    p_requested integer,
    p_daily_limit integer default 70
)
returns table (allowed boolean, used_count integer, remaining integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_row public.api_usage_daily%rowtype;
begin
    if not public.is_app_owner(p_owner_id)
       or p_requested < 1 or p_requested > 10
       or p_daily_limit < 1 or p_daily_limit > 1000
       or (p_provider = 'api_football' and p_daily_limit > 70)
       or length(btrim(coalesce(p_provider, ''))) = 0
       or length(btrim(coalesce(p_endpoint, ''))) = 0 then
        raise exception 'invalid API reservation' using errcode = '22023';
    end if;

    insert into public.api_usage_daily (
        owner_id, provider, usage_date, used_count, daily_limit
    ) values (
        p_owner_id, p_provider, (now() at time zone 'utc')::date, 0, p_daily_limit
    )
    on conflict (owner_id, provider, usage_date) do nothing;

    select * into v_row
    from public.api_usage_daily u
    where u.owner_id = p_owner_id
      and u.provider = p_provider
      and u.usage_date = (now() at time zone 'utc')::date
    for update;

    if v_row.used_count + p_requested > least(v_row.daily_limit, p_daily_limit) then
        return query select false, v_row.used_count,
            greatest(0, least(v_row.daily_limit, p_daily_limit) - v_row.used_count);
        return;
    end if;

    update public.api_usage_daily u
    set used_count = u.used_count + p_requested,
        daily_limit = least(u.daily_limit, p_daily_limit),
        endpoint_breakdown = jsonb_set(
            u.endpoint_breakdown,
            array[p_endpoint],
            to_jsonb(coalesce((u.endpoint_breakdown->>p_endpoint)::integer, 0) + p_requested),
            true
        ),
        updated_at = now()
    where u.owner_id = p_owner_id
      and u.provider = p_provider
      and u.usage_date = (now() at time zone 'utc')::date
    returning u.used_count into v_row.used_count;

    return query select true, v_row.used_count,
        greatest(0, least(v_row.daily_limit, p_daily_limit) - v_row.used_count);
end;
$$;

create or replace function public.reserve_fixture_provider_call(
    p_owner_id uuid,
    p_fixture_id uuid,
    p_provider text,
    p_counter_name text,
    p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_used integer;
begin
    if not public.is_app_owner(p_owner_id) or p_limit < 1 or p_limit > 20 then
        raise exception 'invalid fixture API reservation' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.fixtures
        where id = p_fixture_id and owner_id = p_owner_id
    ) then
        raise exception 'fixture not found' using errcode = 'P0002';
    end if;

    insert into public.fixture_provider_counters (
        owner_id, fixture_id, provider, counter_name, used_count
    ) values (p_owner_id, p_fixture_id, p_provider, p_counter_name, 0)
    on conflict (owner_id, fixture_id, provider, counter_name) do nothing;

    select used_count into v_used
    from public.fixture_provider_counters
    where owner_id = p_owner_id and fixture_id = p_fixture_id
      and provider = p_provider and counter_name = p_counter_name
    for update;

    if v_used >= p_limit then
        return false;
    end if;

    update public.fixture_provider_counters
    set used_count = used_count + 1, updated_at = now()
    where owner_id = p_owner_id and fixture_id = p_fixture_id
      and provider = p_provider and counter_name = p_counter_name;
    return true;
end;
$$;

-- Atomic promotion used only by the offline training job. The job computes the
-- walk-forward/bootstrap metrics; the database refuses promotion unless every
-- conservative gate is present and favorable in the immutable metrics JSON.
create or replace function public.promote_model_version(
    p_owner_id uuid,
    p_model_version_id uuid
)
returns public.model_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_model public.model_versions%rowtype;
begin
    if not public.is_app_owner(p_owner_id) then
        raise exception 'configured owner required' using errcode = '42501';
    end if;

    select * into v_model
    from public.model_versions
    where id = p_model_version_id and owner_id = p_owner_id
    for update;
    if not found then
        raise exception 'model version not found' using errcode = 'P0002';
    end if;
    if v_model.status not in ('shadow', 'champion')
       or v_model.model_family <> 'dixon_coles_elo' then
        raise exception 'only the validated Dixon-Coles/Elo distribution can be promoted'
            using errcode = '22023';
    end if;
    if v_model.feature_schema_version <> 'football-result-only-v1'
       or v_model.parameters ->> 'artifact_schema_version' <> 'betledger-model-artifact/v1'
       or v_model.parameters -> 'result_only' is distinct from 'true'::jsonb
       or v_model.parameters ->> 'inference_contract_version' <> 'football-probability-v1'
       or v_model.parameters ->> 'feature_schema_version' <> 'football-result-only-v1'
       or v_model.parameters ->> 'uncertainty_method' <> 'poisson_exposure_qmc_v1'
       or v_model.parameters -> 'max_goals' is distinct from '10'::jsonb
       or jsonb_typeof(v_model.parameters -> 'rho') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'intercept_log') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'home_advantage_log') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'elo_coefficient') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'elo_home_advantage') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'log_rate_uncertainty_sd') <> 'number'
       or jsonb_typeof(v_model.parameters -> 'team_ratings') <> 'object'
       or jsonb_typeof(v_model.parameters -> 'competition_models') <> 'object' then
        raise exception 'model inference contract is incomplete or incompatible'
            using errcode = '22023';
    end if;
    if jsonb_object_length(v_model.parameters -> 'competition_models') = 0 then
        raise exception 'model inference contract is incomplete or incompatible'
            using errcode = '22023';
    end if;
    if (v_model.parameters ->> 'log_rate_uncertainty_sd')::numeric not between 0.06 and 0.30
       or exists (
            select 1
            from jsonb_each(v_model.parameters -> 'competition_models') as competition(code, value)
            where jsonb_typeof(competition.value) <> 'object'
               or competition.value ->> 'uncertainty_method' <> 'poisson_exposure_qmc_v1'
               or jsonb_typeof(competition.value -> 'log_rate_uncertainty_sd') <> 'number'
               or jsonb_typeof(competition.value -> 'rho') <> 'number'
               or jsonb_typeof(competition.value -> 'intercept_log') <> 'number'
               or jsonb_typeof(competition.value -> 'home_advantage_log') <> 'number'
               or jsonb_typeof(competition.value -> 'elo_coefficient') <> 'number'
               or jsonb_typeof(competition.value -> 'elo_home_advantage') <> 'number'
               or jsonb_typeof(competition.value -> 'team_ratings') <> 'object'
       ) then
        raise exception 'model uncertainty contract is invalid'
            using errcode = '22023';
    end if;
    if exists (
        select 1
        from jsonb_each(v_model.parameters -> 'competition_models') as competition(code, value)
        where (competition.value ->> 'log_rate_uncertainty_sd')::numeric not between 0.06 and 0.30
    ) then
        raise exception 'competition uncertainty scale is outside the supported range'
            using errcode = '22023';
    end if;
    if coalesce((v_model.metrics->>'promotion_eligible')::boolean, false) is not true
       or coalesce((v_model.metrics->>'relative_log_loss_improvement')::numeric, -1) < 0.01
       or coalesce((v_model.metrics->>'bootstrap_log_loss_ci_low')::numeric, -1) <= 0
       or coalesce((v_model.metrics->>'brier_not_worse')::boolean, false) is not true
       or coalesce((v_model.metrics->>'calibration_not_worse')::boolean, false) is not true
       or coalesce((v_model.metrics->>'max_competition_degradation')::numeric, 1) > 0.02
       or coalesce((v_model.metrics->>'max_horizon_degradation')::numeric, 1) > 0.02 then
        raise exception 'model does not satisfy promotion gates' using errcode = '22023';
    end if;

    update public.model_versions
    set status = 'retired'
    where owner_id = p_owner_id and status = 'champion' and id <> p_model_version_id;

    update public.model_versions
    set status = 'champion', promoted_at = now()
    where id = p_model_version_id
    returning * into v_model;
    return v_model;
end;
$$;

create or replace function public.set_competition_recommendation_activation(
    p_owner_id uuid,
    p_competition_id uuid,
    p_enabled boolean,
    p_completed_fixture_count integer,
    p_central_coverage numeric,
    p_official_lineup_coverage numeric,
    p_validation_report jsonb default '{}'::jsonb
)
returns public.competition_recommendation_activation
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_activation public.competition_recommendation_activation%rowtype;
    v_shadow_started_at timestamptz;
begin
    if not public.is_app_owner(p_owner_id)
       or not exists (
           select 1 from public.competitions
           where id = p_competition_id and owner_id = p_owner_id
       ) then
        raise exception 'configured owner and competition required' using errcode = '42501';
    end if;
    if p_completed_fixture_count < 0
       or p_enabled is null
       or p_central_coverage not between 0 and 1
       or p_official_lineup_coverage not between 0 and 1
       or jsonb_typeof(coalesce(p_validation_report, '{}'::jsonb)) <> 'object' then
        raise exception 'invalid activation metrics' using errcode = '22023';
    end if;
    select shadow_started_at into v_shadow_started_at
    from public.competition_recommendation_activation
    where owner_id = p_owner_id and competition_id = p_competition_id
    for update;
    v_shadow_started_at := coalesce(v_shadow_started_at, now());
    if p_enabled and (
        v_shadow_started_at > now() - interval '30 days'
        or p_completed_fixture_count < 100
        or p_central_coverage < 0.99
        or p_official_lineup_coverage < 0.80
    ) then
        raise exception 'competition has not satisfied the paper-candidate activation gates'
            using errcode = '22023';
    end if;

    insert into public.competition_recommendation_activation (
        owner_id, competition_id, enabled, evaluated_at,
        completed_fixture_count, central_coverage, official_lineup_coverage,
        validation_report, updated_at
    ) values (
        p_owner_id, p_competition_id, p_enabled, now(),
        p_completed_fixture_count, p_central_coverage, p_official_lineup_coverage,
        coalesce(p_validation_report, '{}'::jsonb), now()
    )
    on conflict (owner_id, competition_id) do update
    set enabled = excluded.enabled,
        evaluated_at = excluded.evaluated_at,
        completed_fixture_count = excluded.completed_fixture_count,
        central_coverage = excluded.central_coverage,
        official_lineup_coverage = excluded.official_lineup_coverage,
        validation_report = excluded.validation_report,
        updated_at = excluded.updated_at
    returning * into v_activation;
    return v_activation;
end;
$$;

-- Read-only scalar contract for the web UI: one row per market/outcome.
create or replace view public.prediction_snapshot_details
with (security_invoker = true)
as
select p.*,
       mv.version as model_version,
       f.kickoff_at,
       f.stage,
       f.status as fixture_status,
       f.season,
       f.home_team_id,
       f.away_team_id,
       f.aggregate_context,
       c.code as competition_code,
       c.name as competition_name,
       ht.name as home_team_name,
       at.name as away_team_name,
       fs.features as context_features,
       fs.data_quality as feature_data_quality,
       fs.evidence_ids as context_evidence_ids,
       fs.has_material_conflict as feature_material_conflict
from public.prediction_snapshots p
join public.model_versions mv
  on mv.id = p.model_version_id and mv.owner_id = p.owner_id
join public.fixtures f
  on f.id = p.fixture_id and f.owner_id = p.owner_id
join public.competitions c
  on c.id = f.competition_id and c.owner_id = p.owner_id
join public.teams ht
  on ht.id = f.home_team_id and ht.owner_id = p.owner_id
join public.teams at
  on at.id = f.away_team_id and at.owner_id = p.owner_id
left join public.context_feature_snapshots fs
  on fs.id = p.feature_snapshot_id and fs.owner_id = p.owner_id;

-- Apply uniform owner-only SELECT RLS to every operational football table.
do $$
declare
    v_table text;
    v_policy text;
begin
    foreach v_table in array array[
        'competitions', 'competition_rule_versions', 'teams',
        'team_provider_mappings', 'fixtures', 'fixture_provider_mappings', 'standings_snapshots',
        'context_observations', 'context_reviews',
        'player_availability_snapshots', 'lineups', 'lineup_players',
        'odds_snapshots', 'provider_payloads', 'context_feature_snapshots',
        'model_versions', 'competition_recommendation_activation', 'training_runs', 'prediction_snapshots',
        'recommendations', 'sync_requests', 'sync_runs', 'api_usage_daily',
        'fixture_provider_counters'
    ] loop
        execute format('alter table public.%I enable row level security', v_table);
        for v_policy in
            select policyname from pg_policies
            where schemaname = 'public' and tablename = v_table
        loop
            execute format('drop policy if exists %I on public.%I', v_policy, v_table);
        end loop;
        execute format(
            'create policy owner_select on public.%I for select to authenticated using (owner_id = auth.uid() and public.is_app_owner())',
            v_table
        );
        execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
        execute format('grant select on table public.%I to authenticated', v_table);
    end loop;
end;
$$;

alter table public.competition_catalog enable row level security;
do $$
declare v_policy text;
begin
    for v_policy in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = 'competition_catalog'
    loop
        execute format('drop policy if exists %I on public.competition_catalog', v_policy);
    end loop;
end;
$$;
drop policy if exists competition_catalog_owner_select on public.competition_catalog;
create policy competition_catalog_owner_select on public.competition_catalog
for select to authenticated using (public.is_app_owner());
revoke all on table public.competition_catalog from public, anon, authenticated;
grant select on table public.competition_catalog to authenticated;

revoke all on table public.prediction_snapshot_details from public, anon, authenticated;
grant select on table public.prediction_snapshot_details to authenticated;

revoke all on function public.review_context_observation(uuid, text, text, text, jsonb)
    from public, anon;
revoke all on function public.register_recommendation(uuid, text, jsonb)
    from public, anon;
grant execute on function public.review_context_observation(uuid, text, text, text, jsonb)
    to authenticated;
grant execute on function public.register_recommendation(uuid, text, jsonb)
    to authenticated;

revoke all on function public.reserve_api_calls(uuid, text, text, integer, integer)
    from public, anon, authenticated;
revoke all on function public.reconcile_fixture_recommendation(uuid, uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.reserve_fixture_provider_call(uuid, uuid, text, text, integer)
    from public, anon, authenticated;
revoke all on function public.promote_model_version(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.set_competition_recommendation_activation(uuid, uuid, boolean, integer, numeric, numeric, jsonb)
    from public, anon, authenticated;
grant execute on function public.reserve_api_calls(uuid, text, text, integer, integer)
    to service_role;
grant execute on function public.reconcile_fixture_recommendation(uuid, uuid, uuid)
    to service_role;
grant execute on function public.reserve_fixture_provider_call(uuid, uuid, text, text, integer)
    to service_role;
grant execute on function public.promote_model_version(uuid, uuid)
    to service_role;
grant execute on function public.set_competition_recommendation_activation(uuid, uuid, boolean, integer, numeric, numeric, jsonb)
    to service_role;

commit;
