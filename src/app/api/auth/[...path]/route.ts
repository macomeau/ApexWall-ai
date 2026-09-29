import { auth } from "@/lib/auth/server";

/**
 * Lazily resolve the Managed Auth handlers per request, so `next build`
 * doesn't require NEON_AUTH_* env vars — only real requests do.
 */
async function handle(req: Request, ctx: any): Promise<Response> {
  const handlers = auth.handler() as unknown as Record<
    string,
    (req: Request, ctx: any) => Promise<Response>
  >;
  const fn = handlers[req.method];
  if (!fn) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return fn(req, ctx);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
