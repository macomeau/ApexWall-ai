/**
 * Shared telemetry-session handlers — framework-agnostic.
 *
 * Used by the Neon Functions Hono app (neon/api/index.ts, which resolves the
 * session via the managed auth server). Only relative imports here: the
 * function bundler has no "@/" alias.
 *
 * A session stores the browser-parsed telemetry digest (downsampled points,
 * summary metrics, anomalies, comparisons) plus the AI analysis result, so a
 * session analyzed on one device can be reopened on another. The raw uploaded
 * file itself is never stored.
 */
import { sql } from "./db";

export interface HandlerResult {
  status: number;
  json: any;
}

function toSessionMeta(row: any) {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    game: row.game,
    car: row.car,
    track: row.track,
    lapTime: row.lap_time,
    createdAt: row.created_at,
  };
}

function toSessionFull(row: any) {
  return {
    ...toSessionMeta(row),
    payload: row.payload,
    analysis: row.analysis,
  };
}

/** GET /api/telemetry — list the signed-in user's sessions (metadata only). */
export async function listTelemetrySessions(
  userId: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  const rows = (await sql`
    SELECT id, name, filename, game, car, track, lap_time, created_at
    FROM public.telemetry_sessions
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 100
  `) as any[];
  return { status: 200, json: rows.map(toSessionMeta) };
}

/** GET /api/telemetry/:id — full session with payload + analysis. */
export async function getTelemetrySession(
  userId: string | null,
  id: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!id) {
    return { status: 400, json: { error: "Missing session id." } };
  }
  const rows = (await sql`
    SELECT *
    FROM public.telemetry_sessions
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `) as any[];
  if (rows.length === 0) {
    return { status: 404, json: { error: "Session not found." } };
  }
  return { status: 200, json: toSessionFull(rows[0]) };
}

/** POST /api/telemetry — save a new analyzed session. */
export async function saveTelemetrySession(
  userId: string | null,
  body: any
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!body || !body.payload) {
    return { status: 400, json: { error: "Missing telemetry payload." } };
  }
  const id =
    typeof body.id === "string" && body.id.length > 0
      ? body.id
      : `tel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const rows = (await sql`
    INSERT INTO public.telemetry_sessions (
      id, user_id, name, filename, game, car, track, lap_time, payload, analysis
    ) VALUES (
      ${id},
      ${userId},
      ${body.name ?? "Telemetry session"},
      ${body.filename ?? null},
      ${body.game ?? null},
      ${body.car ?? null},
      ${body.track ?? null},
      ${body.lapTime ?? null},
      ${JSON.stringify(body.payload)}::jsonb,
      ${body.analysis ? JSON.stringify(body.analysis) : null}::jsonb
    )
    RETURNING id, name, filename, game, car, track, lap_time, created_at
  `) as any[];
  return { status: 200, json: toSessionMeta(rows[0]) };
}

/** DELETE /api/telemetry?id= — delete one of the user's sessions. */
export async function deleteTelemetrySession(
  userId: string | null,
  id: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!id) {
    return { status: 400, json: { error: "Missing session id." } };
  }
  await sql`
    DELETE FROM public.telemetry_sessions
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return { status: 200, json: { ok: true } };
}
