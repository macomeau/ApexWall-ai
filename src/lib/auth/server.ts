import { createNeonAuth } from "@neondatabase/auth/next/server";

type NeonAuth = ReturnType<typeof createNeonAuth>;

function createAuth(): NeonAuth {
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  const secret = process.env.NEON_AUTH_COOKIE_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "NEON_AUTH_BASE_URL / NEON_AUTH_COOKIE_SECRET are not configured in environment variables."
    );
  }
  return createNeonAuth({ baseUrl, cookies: { secret } });
}

let cached: NeonAuth | null = null;
function getAuth(): NeonAuth {
  if (!cached) cached = createAuth();
  return cached;
}

/**
 * Lazy auth instance — created on first use so `next build` succeeds
 * without the secrets; only real requests require them.
 */
export const auth = new Proxy({} as Record<string | symbol, unknown>, {
  get(_target, prop) {
    const instance = getAuth() as any;
    const value = instance[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
}) as unknown as NeonAuth;
