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
async function jsonBody(c: any) {
  const body = await c.req.json().catch(() => null);
  return body;
}

app.post("/api/generate-setup", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await handleGenerateSetup(body);
  return c.json(json, status as any);
});

app.post("/api/analyze-telemetry", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await handleAnalyzeTelemetry(body);
  return c.json(json, status as any);
});

app.post("/api/race-engineer", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON request body." }, 400);
  const { status, json } = await handleRaceEngineer(body);
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
