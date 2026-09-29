import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { sql } from "@/lib/db";
import { toSetupRecord } from "@/lib/vault-rows";

/**
 * GET /api/vault/[id] — fetch a single setup.
 * Public setups are readable by anyone (share links); private ones only by
 * the owner. Used by the /setup/[id] share page.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { data: session } = await auth.getSession();
  const userId = session?.user?.id ?? null;

  const rows = (await sql`
    SELECT * FROM public.pitwall_setups
    WHERE id = ${params.id}
    LIMIT 1
  `) as any[];

  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = rows[0];
  const isOwner = userId !== null && row.user_id === userId;
  if (!row.is_public && !isOwner) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(toSetupRecord(row));
}
