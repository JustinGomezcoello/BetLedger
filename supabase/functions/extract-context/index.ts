import { requireActor } from '../_shared/auth.ts';
import { errorResponse, HttpError, jsonResponse, optionsResponse, parseJsonBody } from '../_shared/http.ts';
import { extractContextFact, sha256Hex } from '../_shared/source-extraction.ts';
import { fetchSourceText, isOfficialHost, safeSourceUrl } from '../_shared/ssrf.ts';

type RequestBody = {
  fixture_id?: string;
  team_id?: string;
  source_url?: string;
  published_at?: string;
  valid_until?: string;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405);

  try {
    const actor = await requireActor(request);
    const body = await parseJsonBody<RequestBody>(request);
    if (!body.fixture_id || !body.source_url) {
      throw new HttpError(400, 'missing_fields', 'fixture_id y source_url son obligatorios');
    }

    const { data: fixture } = await actor.admin
      .from('fixtures')
      .select('id, home_team_id, away_team_id')
      .eq('id', body.fixture_id)
      .eq('owner_id', actor.userId)
      .maybeSingle();
    if (!fixture) throw new HttpError(404, 'fixture_not_found', 'El partido no existe');

    if (body.team_id) {
      if (![fixture.home_team_id, fixture.away_team_id].includes(body.team_id)) {
        throw new HttpError(400, 'team_not_in_fixture', 'El equipo no participa en este partido');
      }
    }

    for (const [field, value] of [['published_at', body.published_at], ['valid_until', body.valid_until]] as const) {
      if (value && !Number.isFinite(Date.parse(value))) {
        throw new HttpError(400, 'invalid_timestamp', `${field} no es una fecha válida`);
      }
    }
    const publishedAtMs = body.published_at ? Date.parse(body.published_at) : null;
    const validUntilMs = body.valid_until ? Date.parse(body.valid_until) : null;
    if (publishedAtMs !== null && publishedAtMs > Date.now() + 5 * 60_000) {
      throw new HttpError(400, 'future_publication', 'published_at no puede estar en el futuro');
    }
    if (publishedAtMs !== null && validUntilMs !== null && validUntilMs < publishedAtMs) {
      throw new HttpError(400, 'invalid_validity_window', 'valid_until no puede ser anterior a published_at');
    }

    const url = safeSourceUrl(body.source_url);
    const html = await fetchSourceText(url);
    const extracted = extractContextFact(html);
    const now = new Date().toISOString();
    const sourceHash = await sha256Hex(`${url.toString()}\n${body.published_at ?? ''}\n${extracted.fingerprintMaterial}`);
    const sourceTier = isOfficialHost(url.hostname.toLowerCase()) ? 'official' : 'press';
    const oppositeTypes: Record<string, string[]> = {
      injury: ['return'],
      suspension: ['return'],
      return: ['injury', 'suspension'],
    };
    const opposites = oppositeTypes[extracted.observationType] ?? [];
    let conflictingIds: string[] = [];
    let conflictGroup: string | null = null;
    if (opposites.length) {
      let conflictQuery = actor.admin.from('context_observations')
        .select('id')
        .eq('owner_id', actor.userId)
        .eq('fixture_id', body.fixture_id)
        .in('observation_type', opposites)
        .neq('review_status', 'rejected');
      conflictQuery = body.team_id
        ? conflictQuery.eq('team_id', body.team_id)
        : conflictQuery.is('team_id', null);
      const conflicts = await conflictQuery;
      if (conflicts.error) throw new HttpError(500, 'conflict_read_failed', conflicts.error.message);
      conflictingIds = (conflicts.data ?? []).map((item) => item.id);
      if (conflictingIds.length) {
        conflictGroup = await sha256Hex(`availability:${body.fixture_id}:${body.team_id ?? 'fixture'}`);
      }
    }

    let inserted = true;
    let { data, error } = await actor.admin
      .from('context_observations')
      .insert({
        owner_id: actor.userId,
        fixture_id: body.fixture_id,
        team_id: body.team_id ?? null,
        entity_type: body.team_id ? 'team' : 'fixture',
        observation_type: extracted.observationType,
        evidence_summary: extracted.summary,
        source_tier: sourceTier,
        confidence: sourceTier === 'official' ? 0.8 : 0.55,
        source_url: url.toString(),
        source_hash: sourceHash,
        published_at: body.published_at ?? null,
        observed_at: now,
        fetched_at: now,
        valid_from: now,
        expires_at: body.valid_until ?? null,
        review_status: 'pending',
        initial_review_status: 'pending',
        is_conflicted: conflictingIds.length > 0,
        conflict_group: conflictGroup,
        metadata: {
          extractor: 'rule_based_v2',
          untrusted_source_text: true,
          source_title: extracted.sourceTitle || null,
        },
      })
      .select('id, fixture_id, observation_type, evidence_summary, source_tier, review_status')
      .single();
    if (error?.code === '23505') {
      inserted = false;
      const existing = await actor.admin.from('context_observations')
        .select('id, fixture_id, observation_type, evidence_summary, source_tier, review_status')
        .eq('owner_id', actor.userId)
        .eq('fixture_id', body.fixture_id)
        .eq('source_hash', sourceHash)
        .single();
      data = existing.data;
      error = existing.error;
    }
    if (error) throw new HttpError(500, 'observation_write_failed', 'No se pudo guardar la evidencia');
    if ((inserted || data?.review_status === 'pending') && extracted.observationType !== 'other') {
      const expired = await actor.admin.from('recommendations')
        .update({ status: 'expired' })
        .eq('owner_id', actor.userId)
        .eq('fixture_id', body.fixture_id)
        .eq('status', 'available');
      if (expired.error) throw new HttpError(500, 'recommendation_expiry_failed', expired.error.message);
    }
    if (conflictingIds.length && conflictGroup) {
      const conflictWrite = await actor.admin.from('context_observations')
        .update({ is_conflicted: true, conflict_group: conflictGroup })
        .eq('owner_id', actor.userId)
        .in('id', conflictingIds);
      if (conflictWrite.error) throw new HttpError(500, 'conflict_write_failed', conflictWrite.error.message);
    }

    return jsonResponse(request, { observation: data });
  } catch (error) {
    return errorResponse(request, error);
  }
});
