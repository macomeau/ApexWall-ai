import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import {
  listVaultSetups,
  upsertVaultSetup,
  deleteVaultSetup,
} from "@/lib/vault-handlers";

async function requireUserId(): Promise<string | null> {
  const { data: session } = await auth.getSession();
  return session?.user?.id ?? null;
}

/** GET /api/vault — list the signed-in user's cloud setups. */
export async function GET() {
  const { status, json } = await listVaultSetups(await requireUserId());
  return NextResponse.json(json, { status });
}

/** POST /api/vault — upsert a setup for the signed-in user. */
export async function POST(request: Request) {
  const { status, json } = await upsertVaultSetup(await requireUserId(), await request.json());
  return NextResponse.json(json, { status });
}

/** DELETE /api/vault?id=... — delete the signed-in user's setup. */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const { status, json } = await deleteVaultSetup(await requireUserId(), searchParams.get("id"));
  return NextResponse.json(json, { status });
}
