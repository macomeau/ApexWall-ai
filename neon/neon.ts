import { defineConfig } from "@neon/config/v1";

// Function env is injected from `neon deploy --env <file>` (see deploy.sh).
// Keys are only declared when set, so a redeploy never clobbers a value that
// was updated in place (e.g. the AI Gateway token via `neon functions deploy
// --env KEY=VALUE`). Auth and AI Gateway are already enabled on the branch
// and are intentionally not redeclared here.
const env: Record<string, string> = {};
for (const k of [
  "DATABASE_URL",
  "NEON_AUTH_BASE_URL",
  "NEON_AI_GATEWAY_BASE_URL",
  "NEON_AI_GATEWAY_TOKEN",
  "AI_MODELS",
  "AI_CHAT_MODELS",
]) {
  if (process.env[k]) env[k] = process.env[k]!;
}

export default defineConfig({
  functions: {
    apexwall: { name: "apexwall", source: "./api/index.ts", env },
  },
});
