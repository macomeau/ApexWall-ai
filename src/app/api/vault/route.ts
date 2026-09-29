import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { sql } from "@/lib/db";
import { toSetupRecord } from "@/lib/vault-rows";

async function requireUser() {
  const { data: session } = await auth.getSession();
  return session?.user ?? null;
}

/** GET /api/vault — list the signed-in user's cloud setups. */
export async function GET() {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = (await sql`
    SELECT * FROM public.pitwall_setups
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
  `) as any[];
  return NextResponse.json(rows.map(toSetupRecord));
}

/** POST /api/vault — upsert a setup for the signed-in user. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const sections = JSON.stringify(body.sections || []);

  const rows = (await sql`
    INSERT INTO public.pitwall_setups (
      id, user_id, name, game, car, track, session_type, weather,
      track_temp, air_temp, tyre_compound, fuel_load, lap_time, driver_style,
      summary, engineer_notes, sections, is_public, share_slug, updated_at
    ) VALUES (
      ${body.id}, ${user.id}, ${body.name}, ${body.game}, ${body.car}, ${body.track},
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
    WHERE public.pitwall_setups.user_id = ${user.id}
    RETURNING *
  `) as any[];

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "Setup not found or not owned by you" },
      { status: 403 }
    );
  }
  return NextResponse.json(toSetupRecord(rows[0]));
}

/** DELETE /api/vault?id=... — delete the signed-in user's setup. */
export async function DELETE(request: Request) {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  await sql`
    DELETE FROM public.pitwall_setups
    WHERE id = ${id} AND user_id = ${user.id}
  `;
  return NextResponse.json({ ok: true });
}
