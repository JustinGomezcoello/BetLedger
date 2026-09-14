import { requireActor } from '../_shared/auth.ts';
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJsonBody } from '../_shared/http.ts';

type RequestBody = {
  observation_id?: string;
  decision?: 'approved' | 'corrected' | 'rejected';
  idempotency_key?: string;
  corrected_summary?: string;
  scenario_adjustment?: Record<string, unknown>;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405);
  try {
    const actor = await requireActor(request);
    if (!actor.userClient) throw new HttpError(401, 'user_session_required', 'Se requiere sesión de usuario');
    const body = await parseJsonBody<RequestBody>(request);
    if (!body.observation_id || !body.decision || !body.idempotency_key) {
      throw new HttpError(400, 'missing_fields', 'observation_id, decision e idempotency_key son obligatorios');
    }
    if (body.idempotency_key.length < 8 || body.idempotency_key.length > 180) {
      throw new HttpError(400, 'invalid_idempotency_key', 'La clave idempotente debe tener 8 a 180 caracteres');
    }
    const { data, error } = await actor.userClient.rpc('review_context_observation', {
      p_observation_id: body.observation_id,
      p_decision: body.decision,
      p_idempotency_key: body.idempotency_key,
      p_corrected_summary: body.corrected_summary ?? null,
      p_scenario_adjustment: body.scenario_adjustment ?? {},
    });
    if (error) throw new HttpError(400, 'review_rejected', error.message);
    const reviewed = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    const conflictGroup = typeof reviewed?.conflict_group === 'string' ? reviewed.conflict_group : null;
    if (conflictGroup) {
      const active = await actor.admin.from('context_observations')
        .select('id')
        .eq('owner_id', actor.userId)
        .eq('conflict_group', conflictGroup)
        .in('review_status', ['pending', 'approved', 'corrected']);
      if (active.error) throw new HttpError(500, 'conflict_read_failed', active.error.message);
      if ((active.data ?? []).length <= 1) {
        const resolved = await actor.admin.from('context_observations')
          .update({ is_conflicted: false })
          .eq('owner_id', actor.userId)
          .eq('conflict_group', conflictGroup);
        if (resolved.error) throw new HttpError(500, 'conflict_write_failed', resolved.error.message);
      }
    }
    return jsonResponse(request, { observation: data });
  } catch (error) {
    return errorResponse(request, error);
  }
});
