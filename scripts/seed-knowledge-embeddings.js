/**
 * Seed the setup_knowledge RAG table with embeddings via Neon AI Gateway.
 *
 * Usage: node scripts/seed-knowledge-embeddings.js
 * Requires: NEON_AI_GATEWAY_TOKEN, NEON_AI_GATEWAY_BASE_URL, DATABASE_URL in env
 *
 * Idempotent: skips entries whose title already exists.
 */
const { neon } = require("@neondatabase/serverless");

// Import the seed data (TS -> compile inline via esbuild-register style require)
async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  const GATEWAY_TOKEN = process.env.NEON_AI_GATEWAY_TOKEN;
  const GATEWAY_BASE = (process.env.NEON_AI_GATEWAY_BASE_URL || "").replace(/\/$/, "");
  if (!DATABASE_URL || !GATEWAY_TOKEN || !GATEWAY_BASE) {
    throw new Error("Need DATABASE_URL, NEON_AI_GATEWAY_TOKEN, NEON_AI_GATEWAY_BASE_URL");
  }

  // Load seed entries via tsx/esbuild
  const { SETUP_KNOWLEDGE } = require("../src/lib/setup-knowledge-seed.ts");
  const sql = neon(DATABASE_URL);

  const MODEL = "qwen3-embedding-0-6b";
  console.log(`Seeding ${SETUP_KNOWLEDGE.length} entries with ${MODEL}...`);

  // Check existing
  const existing = await sql`SELECT title FROM setup_knowledge`;
  const existingTitles = new Set(existing.map((r) => r.title));
  const todo = SETUP_KNOWLEDGE.filter((e) => !existingTitles.has(e.title));
  console.log(`${todo.length} new entries to embed`);

  // Batch embeddings (gateway supports up to 150 inputs)
  const BATCH = 50;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const texts = batch.map((e) => `${e.title}\n\n${e.body}`);

    const res = await fetch(`${GATEWAY_BASE}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ model: MODEL, input: texts }),
    });
    if (!res.ok) throw new Error(`Embeddings API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (let j = 0; j < batch.length; j++) {
      const e = batch[j];
      const emb = data.data[j].embedding;
      if (emb.length !== 1024) throw new Error(`Unexpected dims: ${emb.length}`);
      const vecStr = `[${emb.join(",")}]`;
      await sql`
        INSERT INTO setup_knowledge (title, body, category, tags, embedding)
        VALUES (${e.title}, ${e.body}, ${e.category}, ${e.tags}, ${vecStr}::vector)
        ON CONFLICT DO NOTHING
      `;
    }
    console.log(`  embedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }
  console.log("done");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
