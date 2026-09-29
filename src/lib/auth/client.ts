"use client";

import { createAuthClient } from "@neondatabase/auth/next";

// Talks to the same-origin /api/auth proxy (see app/api/auth/[...path]/route.ts).
export const authClient = createAuthClient();
