import { NextRequest, NextResponse } from "next/server";
import { handleRaceEngineer } from "@/lib/ai-handlers";

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const { status, json } = await handleRaceEngineer(body);
  return NextResponse.json(json, { status });
}
