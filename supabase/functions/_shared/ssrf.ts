import { HttpError } from './http.ts';

const DEFAULT_SOURCE_HOSTS = [
  'premierleague.com',
  'laliga.com',
  'bundesliga.com',
  'uefa.com',
  'fifa.com',
];

const isAllowedHost = (hostname: string) => {
  const configured = (Deno.env.get('CONTEXT_SOURCE_HOSTS') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const hosts = [...DEFAULT_SOURCE_HOSTS, ...configured];
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
};

const isUnsafeIpLiteral = (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.includes(':')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
};

export const safeSourceUrl = (raw: string) => {
  if (raw.length > 2_048) {
    throw new HttpError(400, 'invalid_source_url', 'La URL supera el tamano permitido');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_source_url', 'La URL no es válida');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new HttpError(400, 'unsafe_source_url', 'Sólo se aceptan URLs HTTPS públicas');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || isUnsafeIpLiteral(hostname)) {
    throw new HttpError(400, 'unsafe_source_url', 'El destino no es público');
  }
  if (!isAllowedHost(hostname)) {
    throw new HttpError(400, 'source_not_allowed', 'La fuente no está en la lista autorizada');
  }
  url.hash = '';
  return url;
};

export const fetchSourceText = async (url: URL) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'BetLedgerContextBot/1.0 (+private-analysis)' },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new HttpError(400, 'redirect_not_allowed', 'La fuente redirige; usa la URL final autorizada');
    }
    if (!response.ok) throw new HttpError(502, 'source_fetch_failed', `La fuente respondió ${response.status}`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new HttpError(415, 'unsupported_source_type', 'La fuente no contiene texto compatible');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 512_000) throw new HttpError(413, 'source_too_large', 'La fuente supera 512 KB');

    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'empty_source', 'La fuente no devolvió contenido');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512_000) {
        await reader.cancel();
        throw new HttpError(413, 'source_too_large', 'La fuente supera 512 KB');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timeout);
  }
};

export const isOfficialHost = (hostname: string) => DEFAULT_SOURCE_HOSTS.some(
  (host) => hostname === host || hostname.endsWith(`.${host}`),
);
