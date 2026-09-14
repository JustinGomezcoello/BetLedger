import { refreshApiFootballFixture, syncApiFootballCompetitions } from '../_shared/api-football.ts';
import { requireActor } from '../_shared/auth.ts';
import { syncFootballData } from '../_shared/football-data.ts';
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJsonBody } from '../_shared/http.ts';
import { generateFixturePrediction } from '../_shared/prediction.ts';

type RequestBody = {
  scope?: 'all' | 'competition' | 'date' | 'lineup_window';
  competition_code?: string;
  date?: string;
  priority?: number;
  idempotency_key?: string;
};

const SUPPORTED = ['PL', 'PD', 'BL1', 'UCL', 'UEL', 'UECL'];

const validDate = (value: string | undefined) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const utcDate = (offsetDays: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405);
  try {
    const actor = await requireActor(request, { allowAutomation: true });
    const body = await parseJsonBody<RequestBody>(request);
    const scope = body.scope ?? 'all';
    if (!['all', 'competition', 'date', 'lineup_window'].includes(scope)) {
      throw new HttpError(400, 'invalid_scope', 'El alcance no es válido');
    }
    if (scope === 'date' && !validDate(body.date)) {
      throw new HttpError(400, 'invalid_date', 'date debe usar YYYY-MM-DD');
    }
    const competitionCode = body.competition_code?.trim().toUpperCase();
    if (scope === 'competition' && (!competitionCode || !SUPPORTED.includes(competitionCode))) {
      throw new HttpError(400, 'invalid_competition', 'La competición no está habilitada');
    }
    const idempotencyKey = body.idempotency_key ?? crypto.randomUUID();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 180) {
      throw new HttpError(400, 'invalid_idempotency_key', 'La clave idempotente debe tener 8 a 180 caracteres');
    }
    const priority = Math.max(1, Math.min(10, Math.trunc(body.priority ?? (actor.automation ? 5 : 9))));
    let competitionId: string | null = null;
    if (competitionCode) {
      const competition = await actor.admin.from('competitions').select('id')
        .eq('owner_id', actor.userId).eq('code', competitionCode).single();
      if (competition.error) throw new HttpError(404, 'competition_not_found', 'La competición no existe');
      competitionId = competition.data.id;
    }

    let { data: syncRequest, error: requestError } = await actor.admin.from('sync_requests').insert({
      owner_id: actor.userId,
      scope,
      competition_id: competitionId,
      requested_date: scope === 'date' ? body.date : null,
      requested_by: actor.automation ? 'schedule' : 'owner',
      priority,
      idempotency_key: idempotencyKey,
      status: 'running',
      started_at: new Date().toISOString(),
    }).select('id, status').maybeSingle();
    if (requestError?.code === '23505') {
      const existing = await actor.admin.from('sync_requests').select('id, status')
        .eq('owner_id', actor.userId).eq('idempotency_key', idempotencyKey).single();
      if (existing.error) throw new HttpError(500, 'sync_request_read_failed', existing.error.message);
      if (['running', 'succeeded', 'partial'].includes(existing.data.status)) {
        return jsonResponse(request, { request: existing.data, status: existing.data.status, deduplicated: true });
      }
      const resumed = await actor.admin.from('sync_requests')
        .update({ status: 'running', started_at: new Date().toISOString(), completed_at: null })
        .eq('id', existing.data.id)
        .in('status', ['queued', 'failed', 'skipped'])
        .select('id, status')
        .maybeSingle();
      requestError = resumed.error;
      syncRequest = resumed.data;
      if (!syncRequest && !requestError) {
        const concurrent = await actor.admin.from('sync_requests').select('id, status')
          .eq('owner_id', actor.userId).eq('idempotency_key', idempotencyKey).single();
        if (concurrent.error) throw new HttpError(500, 'sync_request_read_failed', concurrent.error.message);
        return jsonResponse(request, { request: concurrent.data, status: concurrent.data.status, deduplicated: true });
      }
    }
    if (requestError || !syncRequest) {
      throw new HttpError(500, 'sync_request_failed', requestError?.message ?? 'No se creó la solicitud');
    }

    const runWrite = await actor.admin.from('sync_runs').insert({
      owner_id: actor.userId,
      request_id: syncRequest.id,
      provider: 'orchestrator',
      status: 'running',
    }).select('id').single();
    if (runWrite.error) throw new HttpError(500, 'sync_run_failed', runWrite.error.message);
    const runId = runWrite.data.id;
    let callsUsed = 0;
    let recordsWritten = 0;
    let partial = false;
    const endpoints: Array<Record<string, unknown>> = [];
    const errors: Array<{ stage: string; message: string }> = [];

    try {
      const expired = await actor.admin.from('recommendations')
        .update({ status: 'expired' })
        .eq('owner_id', actor.userId)
        .eq('status', 'available')
        .lt('expires_at', new Date().toISOString());
      if (expired.error) throw new HttpError(500, 'recommendation_cleanup_failed', expired.error.message);

      if (scope === 'lineup_window') {
        const from = new Date().toISOString();
        const to = new Date(Date.now() + 100 * 60_000).toISOString();
        const fixtures = await actor.admin.from('fixtures')
          .select('id, kickoff_at, provider_ids, status, result_available_at')
          .eq('owner_id', actor.userId).in('status', ['scheduled', 'postponed'])
          .gte('kickoff_at', from).lte('kickoff_at', to).order('kickoff_at').limit(40);
        if (fixtures.error) throw new HttpError(500, 'fixtures_read_failed', fixtures.error.message);
        for (const fixture of fixtures.data ?? []) {
          try {
            const refreshed = await refreshApiFootballFixture(actor, fixture);
            callsUsed += refreshed.calls.reduce((sum, call) => sum + call.providerCalls, 0);
            recordsWritten += refreshed.recordsWritten;
            endpoints.push({ fixture_id: fixture.id, calls: refreshed.calls });
            const prediction = await generateFixturePrediction(actor, fixture.id);
            recordsWritten += prediction.skipped ? 0 : prediction.snapshotsWritten ?? 0;
          } catch (error) {
            partial = true;
            errors.push({ stage: `fixture:${fixture.id}`, message: error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido' });
          }
        }
      } else {
        const codes = competitionCode ? [competitionCode] : SUPPORTED;
        if (Deno.env.get('FOOTBALL_DATA_API_KEY')) {
          try {
            const result = await syncFootballData(actor, {
              competitionCodes: codes.filter((code) => ['PL', 'PD', 'BL1', 'UCL'].includes(code)),
              date: scope === 'date' ? body.date : undefined,
            });
            callsUsed += result.callsUsed;
            recordsWritten += result.recordsWritten;
            partial ||= result.quotaExhausted;
            endpoints.push(...result.endpoints);
          } catch (error) {
            partial = true;
            errors.push({ stage: 'football_data', message: error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido' });
          }
        }
        if (Deno.env.get('API_FOOTBALL_KEY')) {
          try {
            // Scheduled and competition refreshes deliberately avoid a full-season
            // scan. Historical ingestion is handled by the offline backfill job,
            // leaving the 70-call budget available for imminent match context.
            const requestedDate = scope === 'date' ? body.date : undefined;
            const result = await syncApiFootballCompetitions(actor, {
              competitionCodes: codes,
              date: requestedDate,
              from: requestedDate ? undefined : utcDate(-1),
              to: requestedDate ? undefined : utcDate(14),
            });
            callsUsed += result.callsUsed;
            recordsWritten += result.recordsWritten;
            partial ||= result.quotaExhausted;
            endpoints.push(...result.endpoints);
          } catch (error) {
            partial = true;
            errors.push({ stage: 'api_football', message: error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido' });
          }
        }
        if (!Deno.env.get('FOOTBALL_DATA_API_KEY') && !Deno.env.get('API_FOOTBALL_KEY')) {
          await actor.admin.from('sync_requests').update({ status: 'queued' }).eq('id', syncRequest.id);
          await actor.admin.from('sync_runs').update({
            status: 'skipped',
            error_code: 'providers_not_configured',
            error_message: 'Configura al menos un proveedor de fútbol.',
            completed_at: new Date().toISOString(),
          }).eq('id', runId);
          return jsonResponse(request, { request_id: syncRequest.id, status: 'queued', queued: true }, 202);
        }

        const upper = scope === 'date'
          ? new Date(`${body.date}T23:59:59.999Z`).toISOString()
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const lower = scope === 'date'
          ? new Date(`${body.date}T00:00:00.000Z`).toISOString()
          : new Date().toISOString();
        let fixtureQuery = actor.admin.from('fixtures').select('id')
          .eq('owner_id', actor.userId).in('status', ['scheduled', 'postponed'])
          .gte('kickoff_at', lower).lte('kickoff_at', upper).order('kickoff_at').limit(100);
        if (competitionId) fixtureQuery = fixtureQuery.eq('competition_id', competitionId);
        const upcoming = await fixtureQuery;
        if (upcoming.error) throw new HttpError(500, 'fixtures_read_failed', upcoming.error.message);
        for (const fixture of upcoming.data ?? []) {
          try {
            const prediction = await generateFixturePrediction(actor, fixture.id);
            recordsWritten += prediction.skipped ? 0 : prediction.snapshotsWritten ?? 0;
          } catch (error) {
            partial = true;
            errors.push({ stage: `prediction:${fixture.id}`, message: error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido' });
          }
        }
      }

      const status = errors.length && recordsWritten === 0 ? 'failed' : partial || errors.length ? 'partial' : 'succeeded';
      const completedAt = new Date().toISOString();
      await actor.admin.from('sync_requests').update({ status, completed_at: completedAt }).eq('id', syncRequest.id);
      await actor.admin.from('sync_runs').update({
        status,
        endpoints,
        calls_used: callsUsed,
        records_written: recordsWritten,
        error_code: errors.length ? 'partial_failures' : null,
        error_message: errors.length ? JSON.stringify(errors).slice(0, 1000) : null,
        completed_at: completedAt,
      }).eq('id', runId);
      return jsonResponse(request, {
        request_id: syncRequest.id,
        status,
        calls_used: callsUsed,
        records_written: recordsWritten,
        errors,
      }, status === 'failed' ? 502 : 200);
    } catch (error) {
      const completedAt = new Date().toISOString();
      await actor.admin.from('sync_requests').update({ status: 'failed', completed_at: completedAt }).eq('id', syncRequest.id);
      await actor.admin.from('sync_runs').update({
        status: 'failed',
        error_code: error instanceof HttpError ? error.code : 'sync_failed',
        error_message: error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido',
        completed_at: completedAt,
      }).eq('id', runId);
      throw error;
    }
  } catch (error) {
    return errorResponse(request, error);
  }
});
