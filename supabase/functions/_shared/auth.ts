import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './http.ts';

// Edge Functions intentionally use an ungenerated schema client: migrations in
// this repository are the source of truth and are checked separately.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, 'public', 'public', any, any>;

export type Actor = {
  userId: string;
  automation: boolean;
  admin: Client;
  userClient: Client | null;
};

const requiredEnv = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, 'missing_server_configuration', `Falta ${name}`);
  return value;
};

const digest = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
};

const equalSecret = async (left: string, right: string) => {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
};

export const requireActor = async (
  request: Request,
  options: { allowAutomation?: boolean } = {},
): Promise<Actor> => {
  const url = requiredEnv('SUPABASE_URL');
  const serviceRole = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createClient<any>(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const automationHeader = request.headers.get('x-betledger-automation');
  const automationSecret = Deno.env.get('BETLEDGER_AUTOMATION_SECRET');
  if (options.allowAutomation && automationHeader && automationSecret
    && await equalSecret(automationHeader, automationSecret)) {
    const { data, error } = await admin
      .from('app_members')
      .select('user_id')
      .eq('role', 'owner')
      .maybeSingle();
    if (error || !data?.user_id) throw new HttpError(503, 'owner_not_configured', 'No existe propietario configurado');
    return { userId: data.user_id, automation: true, admin, userClient: null };
  }

  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, 'authentication_required', 'Se requiere una sesión válida');

  const anonKey = requiredEnv('SUPABASE_ANON_KEY');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userClient = createClient<any>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(match[1]);
  if (userError || !userData.user) throw new HttpError(401, 'invalid_session', 'La sesión no es válida');

  const { data: member, error: memberError } = await admin
    .from('app_members')
    .select('user_id')
    .eq('user_id', userData.user.id)
    .eq('role', 'owner')
    .maybeSingle();
  if (memberError || !member) throw new HttpError(403, 'owner_only', 'Acceso exclusivo del propietario');

  return { userId: userData.user.id, automation: false, admin, userClient };
};
