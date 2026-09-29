import { neon } from "@neondatabase/serverless";

type SqlClient = ReturnType<typeof neon>;

function createSql(): SqlClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured in environment variables.");
  }
  return neon(url);
}

let cached: SqlClient | null = null;
function getSql(): SqlClient {
  if (!cached) cached = createSql();
  return cached;
}

/**
 * Lazy `sql` template-tag client. The underlying Neon client is created on
 * first query, so `next build` succeeds even without DATABASE_URL set —
 * only actual requests require it.
 */
export const sql = new Proxy(function () {}, {
  get(_target, prop) {
    const client = getSql() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
  apply(_target, _thisArg, args) {
    return (getSql() as any)(...args);
  },
}) as unknown as SqlClient;
