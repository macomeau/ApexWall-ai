/**
 * Shared learned-track handlers — framework-agnostic.
 *
 * Used by the Neon Functions Hono app (neon/api/index.ts, which resolves the
 * session via the managed auth server). Only relative imports here: the
 * function bundler has no "@/" alias.
 *
 * A learned track is a circuit geometry the app derived automatically from a
 * user's telemetry (physics-reconstructed shape + curvature-detected corners).
 * Stored per user; matched client-side by match_key or lap distance.
 */
import { sql } from "./db";

export interface HandlerResult {
  status: number;
  json: any;
}

function toTrackMeta(row: any) {
  return {
    id: row.id,
    name: row.name,
    matchKey: row.match_key,
    distanceM: row.distance_m,
    country: row.country,
    source: row.source,
    createdAt: row.created_at,
  };
}

function toTrackFull(row: any) {
  return {
    ...toTrackMeta(row),
    points: row.points,
    corners: row.corners,
    sectors: row.sectors,
  };
}

/** GET /api/learned-tracks — list the signed-in user's learned tracks (metadata only). */
export async function listLearnedTracks(
  userId: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  const rows = (await sql`
    SELECT id, name, match_key, distance_m, country, source, created_at
    FROM public.learned_tracks
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 200
  `) as any[];
  return { status: 200, json: rows.map(toTrackMeta) };
}

/** GET /api/learned-tracks/:id — full learned track with geometry. */
export async function getLearnedTrack(
  userId: string | null,
  id: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!id) {
    return { status: 400, json: { error: "Missing track id." } };
  }
  const rows = (await sql`
    SELECT *
    FROM public.learned_tracks
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `) as any[];
  if (rows.length === 0) {
    return { status: 404, json: { error: "Learned track not found." } };
  }
  return { status: 200, json: toTrackFull(rows[0]) };
}

/** POST /api/learned-tracks — save a newly auto-learned track (idempotent on match_key). */
export async function saveLearnedTrack(
  userId: string | null,
  body: any
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  const matchKey =
    typeof body?.matchKey === "string" && body.matchKey.trim()
      ? body.matchKey.trim().toLowerCase()
      : null;
  if (!matchKey) {
    return { status: 400, json: { error: "Missing matchKey." } };
  }
  if (!Array.isArray(body.points) || body.points.length < 10) {
    return { status: 400, json: { error: "Missing track geometry points." } };
  }

  // Idempotent: don't learn the same track twice.
  const existing = (await sql`
    SELECT id, name, match_key, distance_m, country, source, created_at
    FROM public.learned_tracks
    WHERE user_id = ${userId} AND match_key = ${matchKey}
    LIMIT 1
  `) as any[];
  if (existing.length > 0) {
    return { status: 200, json: { ...toTrackMeta(existing[0]), alreadyKnown: true } };
  }

  const rows = (await sql`
    INSERT INTO public.learned_tracks (
      user_id, name, match_key, distance_m, country, points, corners, sectors, source
    ) VALUES (
      ${userId},
      ${body.name ?? matchKey},
      ${matchKey},
      ${body.distanceM ?? null},
      ${body.country ?? null},
      ${JSON.stringify(body.points)}::jsonb,
      ${JSON.stringify(Array.isArray(body.corners) ? body.corners : [])}::jsonb,
      ${JSON.stringify(Array.isArray(body.sectors) ? body.sectors : [])}::jsonb,
      ${body.source ?? "telemetry"}
    )
    RETURNING id, name, match_key, distance_m, country, source, created_at
  `) as any[];
  return { status: 200, json: toTrackMeta(rows[0]) };
}

/** DELETE /api/learned-tracks?id= — delete one of the user's learned tracks. */
export async function deleteLearnedTrack(
  userId: string | null,
  id: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!id) {
    return { status: 400, json: { error: "Missing track id." } };
  }
  await sql`
    DELETE FROM public.learned_tracks
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return { status: 200, json: { ok: true } };
}
