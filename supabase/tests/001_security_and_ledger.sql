-- Run with `supabase test db` after a local `supabase db reset`.
-- The transaction keeps the test owner and ledger rows out of the database.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, auth, pg_catalog;

select plan(49);

select has_table('public', 'app_members', 'single-owner membership table exists');
select has_table('public', 'manual_bets', 'manual ledger table exists');
select has_table('public', 'bankroll_events', 'immutable bankroll event table exists');
select has_table('public', 'prediction_snapshots', 'prediction snapshot table exists');
select has_table('public', 'recommendations', 'recommendation table exists');

select has_function(
    'public', 'configure_app_owner', array['uuid', 'text'],
    'owner bootstrap RPC exists'
);
select has_function(
    'public', 'place_manual_bet', array['jsonb', 'text'],
    'transactional bet RPC exists'
);
select has_function(
    'public', 'register_recommendation', array['uuid', 'text', 'jsonb'],
    'recommendation registration RPC exists'
);
select has_function(
    'public', 'review_context_observation', array['uuid', 'text', 'text', 'text', 'jsonb'],
    'idempotent context review RPC exists'
);
select has_function(
    'public', 'reconcile_fixture_recommendation', array['uuid', 'uuid', 'uuid'],
    'atomic recommendation reconciliation RPC exists'
);

select is(
    (
        select count(*)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
              'app_members', 'bankroll_profiles', 'channel_bankrolls',
              'manual_bets', 'bankroll_events', 'competitions', 'fixtures',
              'context_observations', 'prediction_snapshots', 'recommendations'
          )
          and not c.relrowsecurity
    ),
    0::bigint,
    'all security-critical tables have RLS enabled'
);

select ok(
    not has_table_privilege('anon', 'public.manual_bets', 'SELECT'),
    'anonymous role cannot read bets'
);
select ok(
    not has_table_privilege('anon', 'public.prediction_snapshots', 'SELECT'),
    'anonymous role cannot read predictions'
);
select ok(
    not has_table_privilege('anon', 'public.prediction_snapshot_details', 'SELECT'),
    'anonymous role cannot read the prediction detail view'
);
select ok(
    has_table_privilege('authenticated', 'public.manual_bets', 'SELECT'),
    'authenticated role receives read access subject to RLS'
);
select ok(
    not has_table_privilege('authenticated', 'public.manual_bets', 'INSERT'),
    'authenticated role cannot bypass the bet RPC with direct inserts'
);
select ok(
    not has_table_privilege('authenticated', 'public.manual_bets', 'UPDATE'),
    'authenticated role cannot bypass settlement RPCs with direct updates'
);
select ok(
    not has_function_privilege('anon', 'public.place_manual_bet(jsonb,text)', 'EXECUTE'),
    'anonymous role cannot execute the bet RPC'
);
select ok(
    has_function_privilege('authenticated', 'public.place_manual_bet(jsonb,text)', 'EXECUTE'),
    'authenticated owner can execute the bet RPC'
);
select ok(
    not has_function_privilege(
        'authenticated',
        'public.reserve_api_calls(uuid,text,text,integer,integer)',
        'EXECUTE'
    ),
    'provider quota RPC remains service-role-only'
);
select ok(
    not has_function_privilege(
        'authenticated',
        'public.reconcile_fixture_recommendation(uuid,uuid,uuid)',
        'EXECUTE'
    ),
    'recommendation publication remains service-role-only'
);

select has_trigger(
    'public', 'bankroll_events', 'bankroll_events_reject_update_delete',
    'bankroll history is append-only'
);
select has_trigger(
    'public', 'context_feature_snapshots', 'context_feature_snapshots_reject_update_delete',
    'feature snapshots are immutable'
);
select has_trigger(
    'public', 'prediction_snapshots', 'prediction_snapshots_reject_update_delete',
    'prediction snapshots are immutable'
);
select has_index(
    'public', 'context_feature_snapshots', 'context_feature_snapshots_generation_hash_idx',
    'concurrent feature generations are deduplicated'
);
select has_index(
    'public', 'prediction_snapshots', 'prediction_snapshots_generation_hash_idx',
    'concurrent prediction generations are deduplicated'
);

insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
    (
        '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
        'betledger-owner@example.invalid', '', now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
    ),
    (
        '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
        'betledger-other@example.invalid', '', now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
    );

select public.configure_app_owner(
    '10000000-0000-4000-8000-000000000001',
    'betledger-owner@example.invalid'
);

select throws_ok(
    $sql$
        select * from public.reserve_api_calls(
            '10000000-0000-4000-8000-000000000001',
            'api_football', 'fixtures', 1, 71
        )
    $sql$,
    '22023',
    'invalid API reservation',
    'API-Football daily ceiling cannot be configured above 70 calls'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);

select is((select count(*) from public.app_members), 0::bigint, 'a non-owner sees no membership row');
select is((select count(*) from public.manual_bets), 0::bigint, 'a non-owner sees no bets');
select is((select count(*) from public.competitions), 0::bigint, 'a non-owner sees no football data');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

select is((select count(*) from public.app_members), 1::bigint, 'the owner sees its membership row');
select is((select count(*) from public.bankroll_profiles), 1::bigint, 'owner bootstrap creates one ledger profile');
select is((select count(*) from public.competitions), 6::bigint, 'owner bootstrap seeds six competitions');
select is(
    (select count(*) from public.bankroll_events where manual_bet_id is null),
    3::bigint,
    'owner bootstrap creates immutable opening checkpoints for profile and channels'
);

select lives_ok(
    $sql$
        select public.place_manual_bet(
            jsonb_build_object(
                'profile_id', (select id::text from public.bankroll_profiles order by created_at limit 1),
                'channel', 'Personal',
                'selection', 'Test fixture: Home',
                'odds', 2.10,
                'stake_norm', 10
            ),
            'pgtap-place-0001'
        )
    $sql$,
    'owner can place a bet through the transactional RPC'
);

select lives_ok(
    $sql$
        select public.place_manual_bet(
            jsonb_build_object(
                'profile_id', (select id::text from public.bankroll_profiles order by created_at limit 1),
                'channel', 'Personal',
                'selection', 'Test fixture: Home',
                'odds', 2.10,
                'stake_norm', 10
            ),
            'pgtap-place-0001'
        )
    $sql$,
    'replaying the same placement key is idempotent'
);

select is(
    (select count(*) from public.manual_bets where idempotency_key = 'pgtap-place-0001'),
    1::bigint,
    'idempotent placement creates exactly one bet'
);

select lives_ok(
    $sql$
        select public.settle_manual_bet(
            (select id from public.manual_bets where idempotency_key = 'pgtap-place-0001'),
            'won',
            'pgtap-settle-0001'
        )
    $sql$,
    'owner can settle a pending bet transactionally'
);

select is(
    (select status from public.manual_bets where idempotency_key = 'pgtap-place-0001'),
    'won'::text,
    'settlement updates the bet result'
);
select is(
    (select count(*) from public.bankroll_events where manual_bet_id = (
        select id from public.manual_bets where idempotency_key = 'pgtap-place-0001'
    )),
    1::bigint,
    'a Personal settlement appends one reconciliable profile event'
);

reset role;
insert into public.teams (id, owner_id, name, country_code) values
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Past Home', 'GB'),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Past Away', 'GB');
insert into public.model_versions (
    id, owner_id, version, model_family, status, training_cutoff,
    artifact_sha256, parameters, metrics, feature_schema_version
) values (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'pgtap-dc-champion', 'dixon_coles_elo', 'champion', now() - interval '1 day',
    repeat('b', 64),
    '{"inference_contract_version":"football-probability-v1","uncertainty_method":"poisson_exposure_qmc_v1"}'::jsonb,
    '{}'::jsonb, 'football-result-only-v1'
);
update public.competition_recommendation_activation
set enabled = true,
    shadow_started_at = now() - interval '31 days',
    evaluated_at = now(),
    completed_fixture_count = 100,
    central_coverage = 0.99,
    official_lineup_coverage = 0.80
where owner_id = '10000000-0000-4000-8000-000000000001'
  and competition_id = (select id from public.competitions where code = 'PL');
insert into public.fixtures (
    id, owner_id, competition_id, season, home_team_id, away_team_id,
    kickoff_at, status
) values (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    (select id from public.competitions where code = 'PL'),
    '2026-27',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    now() - interval '5 minutes', 'scheduled'
);
insert into public.prediction_snapshots (
    id, owner_id, fixture_id, model_version_id, market, outcome, horizon,
    lambda_home, lambda_away, probability_base, probability_contextual,
    interval_low, interval_high, fair_odds, offered_odds, edge,
    lower_bound_edge, probability_positive_ev, data_cutoff,
    odds_observed_at, decision
) values (
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '1x2', 'home', 'official_lineup',
    1.5, 1.0, 0.55, 0.56, 0.53, 0.59, 1.7857, 2.0, 0.12,
    0.06, 0.95, now(), now(), 'paper_candidate'
);
insert into public.recommendations (
    id, owner_id, fixture_id, prediction_snapshot_id, market, outcome,
    selection, offered_odds, fair_odds, edge, lower_bound_edge,
    probability_positive_ev, decision, status, expires_at
) values (
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '1x2', 'home', 'Past Home', 2.0, 1.7857, 0.12, 0.06,
    0.95, 'paper_candidate', 'available', now() + interval '25 minutes'
);
insert into public.context_observations (
    id, owner_id, fixture_id, entity_type, observation_type,
    evidence_summary, source_tier, confidence, source_url, source_hash
) values (
    '70000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'fixture', 'coach_comment', 'Context review test.', 'press', 0.6,
    'https://www.premierleague.com/', repeat('c', 64)
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select lives_ok(
    $sql$
        select public.review_context_observation(
            '70000000-0000-4000-8000-000000000001',
            'approved', 'pgtap-review-0001', null, '{}'::jsonb
        )
    $sql$,
    'owner can approve contextual evidence'
);
select lives_ok(
    $sql$
        select public.review_context_observation(
            '70000000-0000-4000-8000-000000000001',
            'approved', 'pgtap-review-0001', null, '{}'::jsonb
        )
    $sql$,
    'replaying the same context review key is idempotent'
);
select is(
    (select count(*) from public.context_reviews where idempotency_key = 'pgtap-review-0001'),
    1::bigint,
    'idempotent review creates one audit row'
);
select is(
    (select status from public.recommendations where id = '60000000-0000-4000-8000-000000000001'),
    'expired'::text,
    'approving material context expires an older available recommendation'
);

reset role;
select is(
    public.reconcile_fixture_recommendation(
        '10000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        null
    ) ->> 'status',
    'no_candidate'::text,
    'no-candidate reconciliation is retry-safe and leaves no available pick'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select throws_ok(
    $sql$
        select public.register_recommendation(
            '60000000-0000-4000-8000-000000000001',
            'pgtap-register-past-0001'
        )
    $sql$,
    '22023',
    'paper recommendations are not activated or fixture is not pre-match',
    'a recommendation cannot be registered after kickoff'
);

reset role;
insert into public.model_versions (
    owner_id, version, model_family, status, training_cutoff,
    artifact_sha256, parameters, metrics, feature_schema_version
) values (
    '10000000-0000-4000-8000-000000000001',
    'pgtap-gradient-shadow', 'gradient_boosting', 'shadow', now(),
    repeat('a', 64), '{}'::jsonb,
    jsonb_build_object(
        'promotion_eligible', true,
        'relative_log_loss_improvement', 0.02,
        'bootstrap_log_loss_ci_low', 0.01,
        'brier_not_worse', true,
        'calibration_not_worse', true,
        'max_competition_degradation', 0,
        'max_horizon_degradation', 0
    ),
    'gradient-features-v1'
);

select throws_ok(
    $sql$
        select public.promote_model_version(
            '10000000-0000-4000-8000-000000000001',
            (select id from public.model_versions where version = 'pgtap-gradient-shadow')
        )
    $sql$,
    '22023',
    'only the validated Dixon-Coles/Elo distribution can be promoted',
    'a 1X2-only gradient model cannot bypass the single-distribution contract'
);

insert into public.model_versions (
    owner_id, version, model_family, status, training_cutoff,
    artifact_sha256, parameters, metrics, feature_schema_version
) values (
    '10000000-0000-4000-8000-000000000001',
    'pgtap-invalid-dce-contract', 'dixon_coles_elo', 'shadow', now(),
    repeat('b', 64), '{}'::jsonb,
    jsonb_build_object(
        'promotion_eligible', true,
        'relative_log_loss_improvement', 0.02,
        'bootstrap_log_loss_ci_low', 0.01,
        'brier_not_worse', true,
        'calibration_not_worse', true,
        'max_competition_degradation', 0,
        'max_horizon_degradation', 0
    ),
    'football-result-only-v1'
);

select throws_ok(
    $sql$
        select public.promote_model_version(
            '10000000-0000-4000-8000-000000000001',
            (select id from public.model_versions where version = 'pgtap-invalid-dce-contract')
        )
    $sql$,
    '22023',
    'model inference contract is incomplete or incompatible',
    'a promoted model must carry the exact Python-to-TypeScript inference contract'
);

select throws_ok(
    $sql$
        select public.set_competition_recommendation_activation(
            '10000000-0000-4000-8000-000000000001',
            (select id from public.competitions order by code limit 1),
            true, 100, 0.99, 0.80, '{}'::jsonb
        )
    $sql$,
    '22023',
    'competition has not satisfied the paper-candidate activation gates',
    'a competition cannot skip the required 30-day shadow period'
);

select * from finish();
rollback;
