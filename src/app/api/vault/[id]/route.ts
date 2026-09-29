import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { getSetupForShare } from "@/lib/vault-handlers";

/**
 * GET /api/vault/[id] — fetch a single setup.
 * Public setups are readable by anyone (share links); private ones only by
 * the owner. Used by the /setup share page.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { data: session } = await auth.getSession();
  const userId = session?.user?.id ?? null;

  const { status, json } = await getSetupForShare(params.id, userId);
  return NextResponse.json(json, { status });
}
