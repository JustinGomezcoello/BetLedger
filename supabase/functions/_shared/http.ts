export const corsHeaders = (request: Request) => {
  const origin = request.headers.get('origin');
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigin = origin && configured.includes(origin) ? origin : configured[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-betledger-automation',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
};

export const jsonResponse = (
  request: Request,
  payload: unknown,
  status = 200,
) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    ...corsHeaders(request),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

export const optionsResponse = (request: Request) => new Response(null, {
  status: 204,
  headers: corsHeaders(request),
});

export const errorResponse = (request: Request, error: unknown) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Error interno';
  const code = error instanceof HttpError ? error.code : 'internal_error';
  if (!(error instanceof HttpError)) console.error(error);
  return jsonResponse(request, { error: code, message }, status);
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const parseJsonBody = async <T>(request: Request): Promise<T> => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'content_type_required', 'Se requiere application/json');
  }
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'El cuerpo JSON no es válido');
  }
};
