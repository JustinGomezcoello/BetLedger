import { requireActor } from '../_shared/auth.ts';
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJsonBody } from '../_shared/http.ts';

type RequestBody = {
  recommendation_id?: string;
  idempotency_key?: string;
  bet_input?: Record<string, unknown>;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405);
  try {
    const actor = await requireActor(request);
    if (!actor.userClient) throw new HttpError(401, 'user_session_required', 'Se requiere sesión de usuario');
    const body = await parseJsonBody<RequestBody>(request);
    if (!body.recommendation_id || !body.idempotency_key) {
      throw new HttpError(400, 'missing_fields', 'recommendation_id e idempotency_key son obligatorios');
    }
    const { data, error } = await actor.userClient.rpc('register_recommendation', {
      p_recommendation_id: body.recommendation_id,
      p_idempotency_key: body.idempotency_key,
      p_bet_input: body.bet_input ?? {},
    });
    if (error) throw new HttpError(400, 'registration_rejected', error.message);
    return jsonResponse(request, { bet: data }, 201);
  } catch (error) {
    return errorResponse(request, error);
  }
});
