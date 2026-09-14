import { refreshApiFootballFixture } from '../_shared/api-football.ts';
import { requireActor } from '../_shared/auth.ts';
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJsonBody } from '../_shared/http.ts';
import { generateFixturePrediction } from '../_shared/prediction.ts';

type RequestBody = {
  fixture_id?: string;
  idempotency_key?: string;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405);

  try {
    const actor = await requireActor(request, { allowAutomation: true });
    const body = await parseJsonBody<RequestBody>(request);
    if (!body.fixture_id) throw new HttpError(400, 'fixture_required', 'fixture_id es obligatorio');
    const idempotencyKey = body.idempotency_key ?? crypto.randomUUID();

    const { data: fixture, error: fixtureError } = await actor.admin
      .from('fixtures')
      .select('id, kickoff_at, provider_ids, status, result_available_at')
      .eq('id', body.fixture_id)
      .eq('owner_id', actor.userId)
      .maybeSingle();
    if (fixtureError || !fixture) throw new HttpError(404, 'fixture_not_found', 'El partido no existe');
    if (!['scheduled', 'postponed'].includes(fixture.status) || Date.parse(fixture.kickoff_at) <= Date.now()) {
      throw new HttpError(409, 'fixture_not_pre_match', 'Sólo se actualizan partidos que aún no han comenzado');
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 180) {
      throw new HttpError(400, 'invalid_idempotency_key', 'La clave idempotente debe tener 8 a 180 caracteres');
    }

    const requestRecord = {
      owner_id: actor.userId,
      scope: 'fixture',
      fixture_id: fixture.id,
      requested_by: actor.automation ? 'schedule' : 'owner',
      priority: actor.automation ? 5 : 9,
      idempotency_key: idempotencyKey,
      status: Deno.env.get('API_FOOTBALL_KEY') ? 'running' : 'queued',
      started_at: Deno.env.get('API_FOOTBALL_KEY') ? new Date().toISOString() : null,
    };
    let { data: syncRequest, error: requestError } = await actor.admin
      .from('sync_requests')
      .insert(requestRecord)
      .select('id, status')
      .maybeSingle();
    if (requestError?.code === '23505') {
      const existing = await actor.admin.from('sync_requests')
        .select('id, status')
        .eq('owner_id', actor.userId)
        .eq('idempotency_key', idempotencyKey)
        .single();
      syncRequest = existing.data;
      requestError = existing.error;
      if (syncRequest && ['running', 'succeeded', 'partial'].includes(syncRequest.status)) {
        return jsonResponse(request, { request: syncRequest, status: syncRequest.status, deduplicated: true });
      }
      if (syncRequest && ['queued', 'failed', 'skipped'].includes(syncRequest.status)) {
        const providerConfigured = Boolean(Deno.env.get('API_FOOTBALL_KEY'));
        const resumed = await actor.admin.from('sync_requests')
          .update({
            status: providerConfigured ? 'running' : 'queued',
            started_at: providerConfigured ? new Date().toISOString() : null,
            completed_at: null,
          })
          .eq('id', syncRequest.id)
          .in('status', ['queued', 'failed', 'skipped'])
          .select('id, status')
          .maybeSingle();
        syncRequest = resumed.data;
        requestError = resumed.error;
        if (!syncRequest && !requestError) {
          const concurrent = await actor.admin.from('sync_requests')
            .select('id, status')
            .eq('owner_id', actor.userId)
            .eq('idempotency_key', idempotencyKey)
            .single();
          if (concurrent.error) throw new HttpError(500, 'sync_request_read_failed', concurrent.error.message);
          return jsonResponse(request, { request: concurrent.data, status: concurrent.data.status, deduplicated: true });
        }
      }
    }
    if (requestError || !syncRequest) throw new HttpError(500, 'sync_request_failed', requestError?.message ?? 'No se creó la solicitud');

    if (!Deno.env.get('API_FOOTBALL_KEY')) {
      return jsonResponse(request, {
        request: syncRequest,
        status: 'queued',
        queued: true,
        message: 'Solicitud guardada; configura API_FOOTBALL_KEY para ejecutarla.',
      }, 202);
    }

    const startedAt = new Date().toISOString();
    const { data: run, error: runError } = await actor.admin.from('sync_runs').insert({
      owner_id: actor.userId,
      request_id: syncRequest.id,
      provider: 'api_football',
      status: 'running',
      started_at: startedAt,
    }).select('id').single();
    if (runError || !run) {
      await actor.admin.from('sync_requests').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
      }).eq('id', syncRequest.id);
      throw new HttpError(500, 'sync_run_failed', runError?.message ?? 'No se creó la ejecución auditable');
    }

    try {
      const result = await refreshApiFootballFixture(actor, fixture);
      const prediction = await generateFixturePrediction(actor, fixture.id);
      const completedAt = new Date().toISOString();
      const statuses = result.calls.map((call) => call.status);
      const finalStatus = statuses.includes('quota_exhausted') ? 'partial' : 'succeeded';
      await actor.admin.from('sync_requests').update({ status: finalStatus, completed_at: completedAt }).eq('id', syncRequest.id);
      await actor.admin.from('sync_runs').update({
        status: finalStatus,
        endpoints: result.calls,
        calls_used: result.calls.reduce((sum, call) => sum + call.providerCalls, 0),
        records_written: result.recordsWritten + prediction.snapshotsWritten,
        completed_at: completedAt,
      }).eq('id', run.id);
      return jsonResponse(request, { request_id: syncRequest.id, status: finalStatus, result, prediction });
    } catch (error) {
      const completedAt = new Date().toISOString();
      await actor.admin.from('sync_requests').update({ status: 'failed', completed_at: completedAt }).eq('id', syncRequest.id);
      await actor.admin.from('sync_runs').update({
        status: 'failed',
        error_code: error instanceof HttpError ? error.code : 'provider_refresh_failed',
        error_message: error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido',
        completed_at: completedAt,
      }).eq('id', run.id);
      throw error;
    }
  } catch (error) {
    return errorResponse(request, error);
  }
});
