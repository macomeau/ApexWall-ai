/**
 * Shared vault handlers — framework-agnostic.
 *
 * Used by the Next.js route handlers (thin wrappers that resolve the session
 * via @neondatabase/auth) AND by the Neon Functions Hono app
 * (neon/api/index.ts, which resolves the session via the managed auth server).
 * Only relative imports here: the function bundler has no "@/ " alias.
 */
import { sql } from "./db";
import { toSetupRecord } from "./vault-rows";

export interface HandlerResult {
  status: number;
  json: any;
}

/** GET /api/vault — list the signed-in user's cloud setups. */
export async function listVaultSetups(userId: string | null): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }

  const rows = (await sql`
    SELECT * FROM public.pitwall_setups
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `) as any[];
  return { status: 200, json: rows.map(toSetupRecord) };
}

/** POST /api/vault — upsert a setup for the signed-in user. */
export async function upsertVaultSetup(
  userId: string | null,
  body: any
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }

  const sections = JSON.stringify(body.sections || []);

  const rows = (await sql`
    INSERT INTO public.pitwall_setups (
      id, user_id, name, game, car, track, session_type, weather,
      track_temp, air_temp, tyre_compound, fuel_load, lap_time, driver_style,
      summary, engineer_notes, sections, is_public, share_slug, updated_at
    ) VALUES (
      ${body.id}, ${userId}, ${body.name}, ${body.game}, ${body.car}, ${body.track},
      ${body.sessionType ?? null}, ${body.weather ?? null},
      ${body.trackTemp ?? null}, ${body.airTemp ?? null},
      ${body.tyreCompound ?? null}, ${body.fuelLoad ?? null},
      ${body.lapTime ?? null}, ${body.driverStyle ?? null},
      ${body.summary ?? null}, ${body.engineerNotes ?? null},
      ${sections}::jsonb,
      ${body.isPublic ?? true}, ${body.shareSlug ?? body.id}, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      game = EXCLUDED.game,
      car = EXCLUDED.car,
      track = EXCLUDED.track,
      session_type = EXCLUDED.session_type,
      weather = EXCLUDED.weather,
      track_temp = EXCLUDED.track_temp,
      air_temp = EXCLUDED.air_temp,
      tyre_compound = EXCLUDED.tyre_compound,
      fuel_load = EXCLUDED.fuel_load,
      lap_time = EXCLUDED.lap_time,
      driver_style = EXCLUDED.driver_style,
      summary = EXCLUDED.summary,
      engineer_notes = EXCLUDED.engineer_notes,
      sections = EXCLUDED.sections,
      is_public = EXCLUDED.is_public,
      share_slug = EXCLUDED.share_slug,
      updated_at = NOW()
    WHERE public.pitwall_setups.user_id = ${userId}
    RETURNING *
  `) as any[];

  if (rows.length === 0) {
    return { status: 403, json: { error: "Setup not found or not owned by you" } };
  }
  return { status: 200, json: toSetupRecord(rows[0]) };
}

/** DELETE /api/vault?id=... — delete the signed-in user's setup. */
export async function deleteVaultSetup(
  userId: string | null,
  id: string | null
): Promise<HandlerResult> {
  if (!userId) {
    return { status: 401, json: { error: "Unauthorized" } };
  }
  if (!id) {
    return { status: 400, json: { error: "Missing id" } };
  }

  await sql`
    DELETE FROM public.pitwall_setups
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return { status: 200, json: { ok: true } };
}

/**
 * GET /api/vault/[id] — fetch a single setup.
 * Public setups are readable by anyone (share links); private ones only by
 * the owner. Used by the /setup share page.
 */
export async function getSetupForShare(
  id: string,
  userId: string | null
): Promise<HandlerResult> {
  const rows = (await sql`
    SELECT * FROM public.pitwall_setups
    WHERE id = ${id}
    LIMIT 1
  `) as any[];

  if (rows.length === 0) {
    return { status: 404, json: { error: "Not found" } };
  }

  const row = rows[0];
  const isOwner = userId !== null && row.user_id === userId;
  if (!row.is_public && !isOwner) {
    return { status: 404, json: { error: "Not found" } };
  }

  return { status: 200, json: toSetupRecord(row) };
}
