const decodeBasicEntities = (value: string) => value
  .replaceAll('&nbsp;', ' ')
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');

const cleanHtml = (html: string) => decodeBasicEntities(html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

const PATTERNS: Array<{ type: string; expression: RegExp }> = [
  { type: 'suspension', expression: /\b(suspendido|suspensi[oó]n|suspended|ban(?:ned)?|gesperrt)\b/i },
  { type: 'return', expression: /\b(regresa|regreso|recuperad[oa]|vuelve|returns?|fit again|zur[uü]ck)\b/i },
  { type: 'injury', expression: /\b(lesi[oó]n|lesionado|injur(?:y|ed)|fitness doubt|verletz(?:t|ung))\b/i },
  { type: 'rotation', expression: /\b(rotaci[oó]n|suplentes|rotate|rotation|rest players|rotationen)\b/i },
  { type: 'objective_status', expression: /\b(clasificad[oa]|eliminad[oa]|qualified|eliminated|relegat(?:ed|ion)|meister|abstieg)\b/i },
  { type: 'rest', expression: /\b(descanso|fatiga|congesti[oó]n|rest|fatigue|congestion|m[uü]de)\b/i },
  { type: 'coach_comment', expression: /\b(entrenador|t[eé]cnico|coach|manager|trainer)\b/i },
];

const FACTUAL_PARAPHRASES: Record<string, string> = {
  suspension: 'La fuente informa una posible sanción que puede afectar la disponibilidad.',
  injury: 'La fuente informa una lesión o duda física que puede afectar la disponibilidad.',
  return: 'La fuente informa el posible regreso de un jugador a la disponibilidad.',
  rotation: 'La fuente informa una posible rotación o uso de jugadores no habituales.',
  objective_status: 'La fuente informa un cambio relevante en los objetivos competitivos del equipo.',
  rest: 'La fuente informa un factor de descanso, fatiga o congestión del calendario.',
  coach_comment: 'La fuente contiene una declaración del cuerpo técnico que requiere revisión contextual.',
  other: 'La fuente contiene contexto potencial, pero la extracción automática no identificó un hecho específico.',
};

export const extractContextFact = (html: string) => {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanHtml(titleMatch[1]).slice(0, 240) : '';
  const text = cleanHtml(html).slice(0, 24_000);
  const match = PATTERNS.find(({ expression }) => expression.test(`${title} ${text}`));
  const observationType = match?.type ?? 'other';

  return {
    observationType,
    // Store a factual paraphrase, not an article sentence. The normalized text
    // is returned only as hash material and is never written to the database.
    summary: FACTUAL_PARAPHRASES[observationType],
    sourceTitle: title,
    fingerprintMaterial: text,
  };
};

export const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
