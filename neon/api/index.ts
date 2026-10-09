// ApexWall AI — Neon Function entry (Hono).
//
// Serves the statically-exported Next.js UI (embedded at build time by
// scripts/embed-web.mjs) and implements the API surface the UI calls:
//
//   /api/auth/*            transparent proxy -> Neon Auth managed server
//                         (the browser never talks to it directly; cookies
//                         are re-scoped to this host by the proxy, same as
//                         the official Next.js proxy in @neondatabase/auth)
//   POST /api/generate-setup
//   POST /api/analyze-telemetry
//   POST /api/race-engineer   shared logic in ../../src/lib/ai-handlers.ts
//   GET/POST/DELETE /api/vault
//   GET /api/vault/:id        shared logic in ../../src/lib/vault-handlers.ts
//   /setup?id=...            static share page (old /setup/:id links 301 here)
//
// Auth for the vault routes: the managed auth server is the source of truth.
// We forward the client's cookies to <NEON_AUTH_BASE_URL>/get-session and
// take the user id from the response.
import { Hono } from "hono";
import { webAssets } from "./lib/web-dist";
import {
  handleGenerateSetup,
  handleAnalyzeTelemetry,
  handleRaceEngineer,
} from "../../src/lib/ai-handlers";
import { seedKnowledgeBase } from "../../src/lib/knowledge-search";
import {
  listVaultSetups,
  upsertVaultSetup,
  deleteVaultSetup,
  getSetupForShare,
} from "../../src/lib/vault-handlers";
import {
  listTelemetrySessions,
  getTelemetrySession,
  saveTelemetrySession,
  deleteTelemetrySession,
} from "../../src/lib/telemetry-handlers";
import {
  listLearnedTracks,
  getLearnedTrack,
  saveLearnedTrack,
  deleteLearnedTrack,
} from "../../src/lib/learned-track-handlers";

const app = new Hono();

// Global error handler: always return JSON, never plain-text "Internal Server
// Error" — the frontend parses every response as JSON.
app.onError((err, c) => {
  console.error("[api] unhandled error:", err?.message || err);
  return c.json({ error: "Internal server error. Please try again." }, 500);
});

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL;

// ---------- session resolution ----------
async function getSessionUserId(c: any): Promise<string | null> {
  const cookie = c.req.header("cookie");
  if (!cookie || !AUTH_BASE) return null;
  try {
    const r = await fetch(`${AUTH_BASE}/get-session`, {
      headers: { cookie },
    });
    if (!r.ok) return null;
    const data = (await r.json().catch(() => ({}))) as any;
    return data?.user?.id ?? data?.session?.userId ?? null;
  } catch {
    return null;
  }
}

// ---------- /api/auth/* proxy ----------
// Mirrors the official @neondatabase/auth proxy (handleAuthProxyRequest):
// forward an allowlist of request headers, return an allowlist of response
// headers including every Set-Cookie. Cookies arrive without a Domain
// attribute, so the browser scopes them to this host. Redirects are passed
// through untouched (redirect: "manual") so OAuth provider hops work.
const REQ_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "cookie",
  "origin",
  "referer",
  "x-requested-with",
];
const RESP_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "date",
  "location",
  "set-auth-jwt",
  "set-auth-token",
  "x-neon-ret-request-id",
]);

app.all("/api/auth/*", async (c) => {
  if (!AUTH_BASE) return c.json({ error: "auth not configured" }, 500);
  const incoming = new URL(c.req.url);
  const sub = incoming.pathname.slice("/api/auth".length) || "/";
  const target = `${AUTH_BASE}${sub}${incoming.search}`;

  const headers = new Headers();
  for (const h of REQ_HEADERS) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }

  const init: RequestInit = { method: c.req.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(c.req.method)) {
    init.body = c.req.raw.body as any;
    (init as any).duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e: any) {
    return c.json({ error: "auth upstream unreachable" }, 502);
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (RESP_HEADERS.has(k.toLowerCase())) out.append(k, v);
  });
  const getSetCookie = (upstream.headers as any).getSetCookie?.bind(upstream.headers);
  const cookies: string[] = getSetCookie ? getSetCookie() : [];
  if (!cookies.length) {
    const single = upstream.headers.get("set-cookie");
    if (single) cookies.push(single);
  }
  // --- Session cookie normalization ---
  // The upstream sets the session cookie as `SameSite=None; Partitioned` —
  // the classic third-party-tracker shape. Browsers with aggressive tracking
  // prevention (Safari ITP, Comet's shields) delete such cookies when they're
  // set during the Google OAuth redirect chain (app → auth server → Google →
  // auth server → app), treating them as bounce-tracking state even though
  // the cookie itself is first-party. Since all auth traffic goes through
  // this same-site proxy, the cookie never needs cross-site semantics:
  // normalize it to a standard first-party session cookie (`SameSite=Lax`,
  // no `Partitioned`) so the browser never stores the tracker-shaped variant.
  const SESSION_COOKIE = "__Secure-neon-auth.session_token";
  let sessionCookieForwarded = false;
  for (const sc of cookies) {
    if (sc.startsWith(`${SESSION_COOKIE}=`)) {
      sessionCookieForwarded = true;
      const value = sc.split(";")[0].slice(SESSION_COOKIE.length + 1);
      // Preserve deletion cookies (empty/max-age=0) so sign-out keeps working.
      const isDeletion = /max-age\s*=\s*0/i.test(sc) || value === "";
      out.append(
        "set-cookie",
        isDeletion
          ? `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
          : `${SESSION_COOKIE}=${value}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`
      );
    } else {
      out.append("set-cookie", sc);
    }
  }

  // --- Session cookie repair for OAuth logins ---
  // If the upstream didn't set the session cookie on this response (e.g.
  // getSession), but the request carried one, re-emit it with the clean
  // attributes above. This repairs cookies that were stored before this
  // normalization shipped (or set during the OAuth bounce) — the first
  // getSession after landing stores a cookie the browser no longer
  // associates with tracking.
  if (
    upstream.status >= 200 &&
    upstream.status < 300 &&
    !sessionCookieForwarded
  ) {
    const reqCookies = c.req.header("cookie") || "";
    const m = reqCookies.match(
      /(?:^|;\s*)__Secure-neon-auth\.session_token=([^;]+)/
    );
    if (m) {
      out.append(
        "set-cookie",
        `__Secure-neon-auth.session_token=${m[1]}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`
      );
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
});

// ---------- AI routes ----------
import {
  RaceEngineerRequestSchema,
  GenerateSetupRequestSchema,
  MemoryRateLimiter,
  MAX_PAYLOAD_BYTES,
  getClientIp,
} from "../../src/lib/api-schemas";

// In-memory token-bucket limiters (10 req/min per IP per route).
// Per-function-instance; acceptable for a personal deployment.
const generateSetupLimiter = new MemoryRateLimiter(10, 60 * 1000);
const raceEngineerLimiter = new MemoryRateLimiter(10, 60 * 1000);

async function jsonBody(c: any) {
  const body = await c.req.json().catch(() => null);
  return body;
}

/** Shared guard for AI routes: rate limit + payload cap. Returns an error response or null. */
function guardAiRoute(c: any, limiter: MemoryRateLimiter): Response | null {
  const clientIp = getClientIp(c.req.headers as unknown as Headers);
  const { allowed } = limiter.check(clientIp);
  if (!allowed) {
    return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
  }
  const contentLength = c.req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "Payload too large. Maximum allowed size is 32KB." }, 413);
  }
  return null;
}

app.post("/api/generate-setup", async (c) => {
  const guard = guardAiRoute(c, generateSetupLimiter);
  if (guard) return guard;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const parsed = GenerateSetupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request.", details: parsed.error.issues.map((i) => i.message) }, 400);
  }
  const { status, json } = await handleGenerateSetup(parsed.data);
  return c.json(json, status as any);
});

app.post("/api/analyze-telemetry", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await handleAnalyzeTelemetry(body);
  return c.json(json, status as any);
});

app.post("/api/race-engineer", async (c) => {
  const guard = guardAiRoute(c, raceEngineerLimiter);
  if (guard) return guard;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const parsed = RaceEngineerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request.", details: parsed.error.issues.map((i) => i.message) }, 400);
  }
  const { status, json } = await handleRaceEngineer(parsed.data);
  return c.json(json, status as any);
});

// ---------- vault routes ----------
app.get("/api/vault", async (c) => {
  const { status, json } = await listVaultSetups(await getSessionUserId(c));
  return c.json(json, status as any);
});

app.post("/api/vault", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await upsertVaultSetup(await getSessionUserId(c), body);
  return c.json(json, status as any);
});

app.delete("/api/vault", async (c) => {
  const { status, json } = await deleteVaultSetup(
    await getSessionUserId(c),
    c.req.query("id")
  );
  return c.json(json, status as any);
});

app.get("/api/vault/:id", async (c) => {
  const { status, json } = await getSetupForShare(
    c.req.param("id"),
    await getSessionUserId(c)
  );
  return c.json(json, status as any);
});

// ---------- telemetry library routes ----------
app.get("/api/telemetry", async (c) => {
  const { status, json } = await listTelemetrySessions(await getSessionUserId(c));
  return c.json(json, status as any);
});

app.post("/api/telemetry", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await saveTelemetrySession(await getSessionUserId(c), body);
  return c.json(json, status as any);
});

app.delete("/api/telemetry", async (c) => {
  const { status, json } = await deleteTelemetrySession(
    await getSessionUserId(c),
    c.req.query("id")
  );
  return c.json(json, status as any);
});

app.get("/api/telemetry/:id", async (c) => {
  const { status, json } = await getTelemetrySession(
    await getSessionUserId(c),
    c.req.param("id")
  );
  return c.json(json, status as any);
});

// ---------- learned-track routes (auto-learned circuit geometries) ----------
app.get("/api/learned-tracks", async (c) => {
  const { status, json } = await listLearnedTracks(await getSessionUserId(c));
  return c.json(json, status as any);
});

app.post("/api/learned-tracks", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await saveLearnedTrack(await getSessionUserId(c), body);
  return c.json(json, status as any);
});

app.delete("/api/learned-tracks", async (c) => {
  const { status, json } = await deleteLearnedTrack(
    await getSessionUserId(c),
    c.req.query("id")
  );
  return c.json(json, status as any);
});

app.get("/api/learned-tracks/:id", async (c) => {
  const { status, json } = await getLearnedTrack(
    await getSessionUserId(c),
    c.req.param("id")
  );
  return c.json(json, status as any);
});

app.get("/api/health", (c) =>
  c.json({ ok: true, time: new Date().toISOString() })
);

// ---------- lap telemetry ingest (P-006) ----------
// Chunked lap-by-lap upload: each lap POST stays under the function payload
// limit. Client downsamples to <=30Hz before upload.
import { sql } from "../../src/lib/db";

/**
 * Auth for ingest endpoints: session cookie OR bridge API key.
 * Bridge key is pre-shared (BRIDGE_API_KEY) and maps to BRIDGE_USER_ID.
 * Both set via `neon functions deploy --env` — personal deployment only.
 */
async function getIngestUserId(c: any): Promise<string | null> {
  const bridgeKey = c.req.header("x-bridge-key");
  if (
    bridgeKey &&
    process.env.BRIDGE_API_KEY &&
    process.env.BRIDGE_USER_ID &&
    bridgeKey === process.env.BRIDGE_API_KEY
  ) {
    return process.env.BRIDGE_USER_ID;
  }
  return getSessionUserId(c);
}

app.post("/api/sessions", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    INSERT INTO sessions (id, user_id, game, car, track, source)
    VALUES (${id}, ${userId}, ${body.game ?? null}, ${body.car ?? null}, ${body.track ?? null}, ${body.source ?? "upload"})
  `;
  return c.json({ session_id: id });
});

app.get("/api/sessions", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const rows = await sql`
    SELECT id, game, car, track, started_at, ended_at, lap_count, best_lap_time, source
    FROM sessions WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT 50
  `;
  return c.json({ sessions: rows });
});

app.get("/api/sessions/:id", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const sid = c.req.param("id");
  const sess = (await sql`SELECT * FROM sessions WHERE id = ${sid} AND user_id = ${userId}`) as any[];
  if (sess.length === 0) return c.json({ error: "Not found" }, 404);
  const laps = await sql`
    SELECT lap_number, lap_time, is_valid, is_out_lap, is_in_lap,
           sector_times, sector_valid, sample_rate, sample_count
    FROM lap_telemetry WHERE session_id = ${sid} ORDER BY lap_number
  `;
  return c.json({ session: sess[0], laps });
});

app.post("/api/sessions/:id/laps", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const sid = c.req.param("id");
  const sess = (await sql`SELECT id FROM sessions WHERE id = ${sid} AND user_id = ${userId}`) as any[];
  if (sess.length === 0) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.lap_number !== "number") return c.json({ error: "Invalid lap payload" }, 400);
  const ch = body.channels ?? {};
  const arr = (v: any) => (Array.isArray(v) ? v : null);
  await sql`
    INSERT INTO lap_telemetry
      (session_id, user_id, lap_number, lap_time, is_valid, is_out_lap, is_in_lap,
       sector_times, sector_valid, ch_speed, ch_throttle, ch_brake, ch_steer, ch_gear,
       ch_rpm, ch_lat_g, ch_long_g, ch_dist, sample_rate, sample_count, extra_channels)
    VALUES
      (${sid}, ${userId}, ${body.lap_number}, ${body.lap_time ?? null},
       ${body.is_valid ?? true}, ${body.is_out_lap ?? false}, ${body.is_in_lap ?? false},
       ${body.sector_times ?? null}, ${body.sector_valid ?? null},
       ${arr(ch.speed)}, ${arr(ch.throttle)}, ${arr(ch.brake)}, ${arr(ch.steer)}, ${arr(ch.gear)},
       ${arr(ch.rpm)}, ${arr(ch.lat_g)}, ${arr(ch.long_g)}, ${arr(ch.dist)},
       ${body.sample_rate ?? null}, ${body.sample_count ?? null},
       ${JSON.stringify(body.extra_channels ?? {})})
    ON CONFLICT (session_id, lap_number) DO UPDATE SET
      lap_time = EXCLUDED.lap_time, is_valid = EXCLUDED.is_valid,
      sector_times = EXCLUDED.sector_times, ch_speed = EXCLUDED.ch_speed,
      ch_throttle = EXCLUDED.ch_throttle, ch_brake = EXCLUDED.ch_brake,
      ch_steer = EXCLUDED.ch_steer, ch_gear = EXCLUDED.ch_gear,
      ch_rpm = EXCLUDED.ch_rpm, ch_lat_g = EXCLUDED.ch_lat_g,
      ch_long_g = EXCLUDED.ch_long_g, ch_dist = EXCLUDED.ch_dist
  `;
  // Update session aggregates
  await sql`
    UPDATE sessions SET
      lap_count = (SELECT COUNT(*) FROM lap_telemetry WHERE session_id = ${sid}),
      best_lap_time = (SELECT MIN(lap_time) FROM lap_telemetry WHERE session_id = ${sid} AND is_valid AND lap_time IS NOT NULL),
      ended_at = now()
    WHERE id = ${sid}
  `;
  return c.json({ ok: true });
});

import { computeDelta, theoreticalBest } from "../../src/lib/delta";

// F-001: Delta trace between two laps (server-side computation)
app.get("/api/sessions/:id/delta", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const sid = c.req.param("id");
  const refLap = parseInt(c.req.query("ref") ?? "", 10);
  const cmpLap = parseInt(c.req.query("cmp") ?? "", 10);
  if (!Number.isFinite(refLap) || !Number.isFinite(cmpLap)) {
    return c.json({ error: "ref and cmp lap numbers required" }, 400);
  }
  const rows = (await sql`
    SELECT lap_number, ch_speed, ch_dist FROM lap_telemetry
    WHERE session_id = ${sid} AND lap_number IN (${refLap}, ${cmpLap}) AND user_id = ${userId}
  `) as any[];
  const ref = rows.find((r) => r.lap_number === refLap);
  const cmp = rows.find((r) => r.lap_number === cmpLap);
  if (!ref || !cmp || !ref.ch_speed || !cmp.ch_speed) {
    return c.json({ error: "Laps not found or missing channel data" }, 404);
  }
  const result = computeDelta(
    { dist: ref.ch_dist, speed: ref.ch_speed },
    { dist: cmp.ch_dist, speed: cmp.ch_speed }
  );
  if (!result) return c.json({ error: "Could not compute delta" }, 422);
  return c.json({ refLap, cmpLap, ...result });
});

// F-003: Theoretical best from sectors
app.get("/api/sessions/:id/theoretical-best", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const sid = c.req.param("id");
  const sess = (await sql`SELECT id FROM sessions WHERE id = ${sid} AND user_id = ${userId}`) as any[];
  if (sess.length === 0) return c.json({ error: "Not found" }, 404);
  const laps = (await sql`
    SELECT lap_number, sector_times, is_valid FROM lap_telemetry
    WHERE session_id = ${sid} ORDER BY lap_number
  `) as any[];
  const result = theoreticalBest(laps);
  if (!result) return c.json({ error: "No valid sector data" }, 422);
  return c.json(result);
});

app.get("/api/sessions/:id/laps/:lap", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const sid = c.req.param("id");
  const lapNum = parseInt(c.req.param("lap"), 10);
  const rows = (await sql`
    SELECT * FROM lap_telemetry
    WHERE session_id = ${sid} AND lap_number = ${lapNum} AND user_id = ${userId}
  `) as any[];
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ lap: rows[0] });
});

// ---------- telemetry file staging (Neon Object Storage) ----------
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const TELEMETRY_BUCKET = "telemetry-uploads";

function storageClient() {
  // Neon injects AWS_* S3 credentials automatically when the bucket is
  // declared in neon.ts. The SDK picks up credentials/region from env;
  // we only need to set the endpoint and path style explicitly.
  return new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    region: process.env.AWS_REGION || "us-east-2",
    forcePathStyle: true,
  });
}

/** Object key namespaced per user: telemetry/<userId>/<fileId>/<filename> */
function telemetryKey(userId: string, fileId: string, filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return `telemetry/${userId}/${fileId}/${safe}`;
}

// Mint a presigned PUT URL for direct browser upload. The file bytes never
// pass through the function, so the 280KB body limit doesn't apply.
app.post("/api/telemetry-files/presign", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const filename = typeof body?.filename === "string" ? body.filename.slice(0, 200) : "telemetry.csv";
  const contentType = typeof body?.contentType === "string" ? body.contentType.slice(0, 100) : "text/csv";
  const sizeBytes = Number(body?.sizeBytes) || 0;
  if (sizeBytes > 5 * 1024 * 1024 * 1024) return c.json({ error: "File exceeds 5 GiB limit" }, 400);

  const fileId = `tf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const key = telemetryKey(userId, fileId, filename);
  try {
    const s3 = storageClient();
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 900 }
    );
    await sql`
      INSERT INTO telemetry_files (id, user_id, object_key, filename, content_type, size_bytes, status)
      VALUES (${fileId}, ${userId}, ${key}, ${filename}, ${contentType}, ${sizeBytes}, 'pending')
    `;
    return c.json({ fileId, key, uploadUrl: url });
  } catch (e: any) {
    return c.json({ error: e?.message || "presign failed" }, 500);
  }
});

// Confirm an upload completed: verify the object exists, then mark ready.
app.post("/api/telemetry-files/:id/confirm", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const fileId = c.req.param("id");
  const rows = (await sql`SELECT object_key, size_bytes FROM telemetry_files WHERE id = ${fileId} AND user_id = ${userId}`) as any[];
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  try {
    const s3 = storageClient();
    const head = await s3.send(new GetObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: rows[0].object_key, Range: "bytes=0-0" }));
    const actualSize = Number(head.ContentRange?.split("/")[1] || rows[0].size_bytes);
    await sql`UPDATE telemetry_files SET status = 'ready', uploaded_at = now(), size_bytes = ${actualSize} WHERE id = ${fileId}`;
    return c.json({ ok: true, fileId });
  } catch (e: any) {
    await sql`UPDATE telemetry_files SET status = 'failed' WHERE id = ${fileId}`;
    return c.json({ error: "Upload not found in storage — please retry" }, 400);
  }
});

// List the user's staged files, with short-lived download URLs.
app.get("/api/telemetry-files", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await sql`
    SELECT id, filename, content_type, size_bytes, status, game, car, track, lap_count, created_at, uploaded_at, object_key
    FROM telemetry_files WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 50
  `) as any[];
  const s3 = storageClient();
  const files = await Promise.all(rows.map(async (r: any) => {
    let downloadUrl: string | null = null;
    if (r.status === "ready") {
      try {
        downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: r.object_key }),
          { expiresIn: 3600 }
        );
      } catch { /* leave null */ }
    }
    const { object_key, ...rest } = r;
    return { ...rest, downloadUrl };
  }));
  return c.json({ files });
});

// Delete a staged file (object + registry row).
app.delete("/api/telemetry-files/:id", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const fileId = c.req.param("id");
  const rows = (await sql`SELECT object_key FROM telemetry_files WHERE id = ${fileId} AND user_id = ${userId}`) as any[];
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  try {
    await storageClient().send(new DeleteObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: rows[0].object_key }));
  } catch { /* best effort */ }
  await sql`DELETE FROM telemetry_files WHERE id = ${fileId}`;
  return c.json({ ok: true });
});

// ---------- PTT voice transcription (bridge) ----------
// The rig bridge records the driver's push-to-talk audio and POSTs it here
// as raw WAV (16kHz mono 16-bit, <=280KB ≈ 8s). Transcribed via the AI Gateway
// (Gemini audio input) and returned as text for the race engineer chat.
app.post("/api/ptt/transcribe", async (c) => {
  const userId = await getIngestUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("audio/")) {
    return c.json({ error: "Expected audio/* body" }, 400);
  }

  const buf = await c.req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) return c.json({ error: "Empty audio" }, 400);
  if (buf.byteLength > 280 * 1024) return c.json({ error: "Audio too large (max ~8s)" }, 413);

  const token = process.env.NEON_AI_GATEWAY_TOKEN || "";
  const base = (process.env.NEON_AI_GATEWAY_BASE_URL || "").replace(/\/$/, "");
  if (!token || !base) return c.json({ error: "AI Gateway not configured" }, 500);

  const models = (process.env.AI_MODELS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) models.push("gemini-3-flash");

  // Upload audio to S3 and use presigned URL — the gateway's models don't
  // accept inline base64 audio (input_audio unsupported, data URIs ignored).
  const s3 = storageClient();
  const audioKey = `ptt/${userId}/${Date.now()}.wav`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: TELEMETRY_BUCKET,
      Key: audioKey,
      Body: Buffer.from(buf),
      ContentType: "audio/wav",
    }));
  } catch (e: any) {
    return c.json({ error: `S3 upload failed: ${e.message}` }, 500);
  }
  let audioUrl: string;
  try {
    audioUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: audioKey }),
      { expiresIn: 300 } // 5 min — enough for the gateway to fetch
    );
  } catch (e: any) {
    return c.json({ error: `Presign failed: ${e.message}` }, 500);
  }

  let lastErr = "no models tried";
  let transcript = "";
  for (const model of models) {
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Transcribe this sim-racing driver radio message exactly. It may contain motorsport terms (apex, understeer, oversteer, trail braking, etc.). Return only the transcription, no commentary.",
                },
                { type: "audio_url", audio_url: { url: audioUrl } },
              ],
            },
          ],
        }),
      });
      if (!r.ok) {
        lastErr = `model ${model}: HTTP ${r.status}`;
        continue;
      }
      const j: any = await r.json();
      transcript = (j.choices?.[0]?.message?.content || "").trim();
      if (transcript) break;
      lastErr = `model ${model}: empty transcript`;
    } catch (e: any) {
      lastErr = `model ${model}: ${e.message}`;
    }
  }

  // Cleanup S3 object (best effort)
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: TELEMETRY_BUCKET, Key: audioKey }));
  } catch (_e) {}

  if (transcript) return c.json({ transcript });
  return c.json({ error: `Transcription failed: ${lastErr}` }, 502);
});

// One-time admin: seed the RAG knowledge base. Requires auth.
app.post("/api/admin/seed-knowledge", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  try {
    const count = await seedKnowledgeBase();
    return c.json({ ok: true, seeded: count });
  } catch (e: any) {
    return c.json({ error: e?.message || "seed failed" }, 500);
  }
});

// ---------- static web UI (embedded at build time) ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

function serveAsset(c: any, name: string) {
  const b64 = (webAssets as Record<string, string>)[name];
  if (!b64) return c.json({ error: "not found" }, 404);
  const ext = name.slice(name.lastIndexOf("."));
  return new Response(Buffer.from(b64, "base64"), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": name.startsWith("_next/static/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

// Old /setup/:id share links -> /setup?id=:id (static export has no dynamic routes)
app.get("/setup/:id", (c) =>
  c.redirect(`/setup?id=${encodeURIComponent(c.req.param("id"))}`, 301)
);

// Registered last: every /api/* and /api/auth/* route above wins.
app.get("*", (c) => {
  const p = c.req.path;
  if (p.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  if (p === "/") return serveAsset(c, "index.html");
  if (p === "/setup") return serveAsset(c, "setup.html");
  const name = p.slice(1);
  if ((webAssets as Record<string, string>)[name]) return serveAsset(c, name);
  if ((webAssets as Record<string, string>)[name + ".html"])
    return serveAsset(c, name + ".html");
  return serveAsset(c, "index.html");
});

export default app;
