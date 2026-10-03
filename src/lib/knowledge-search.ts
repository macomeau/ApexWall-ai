/**
 * Hybrid search over the setup_knowledge RAG table.
 *
 * Combines:
 *  - Vector similarity (pgvector cosine distance) — semantic matches
 *    ("car won't turn" -> understeer docs)
 *  - Full-text search (tsvector/ts_rank) — keyword matches
 *    ("camber", "Mosport")
 * fused with Reciprocal Rank Fusion (RRF, k=60).
 *
 * On Databricks Lakebase, swap:
 *   embedding <=> query  ->  lakebase_ann index (lakebase_vector ext)
 *   ts_rank(...)         ->  lakebase_bm25 index (lakebase_text ext)
 * The SQL shape is identical.
 */
import { sql } from "./db";
import { SETUP_KNOWLEDGE } from "./setup-knowledge-seed";

export interface KnowledgeHit {
  id: number;
  title: string;
  body: string;
  category: string;
  tags: string[];
  score: number;
}

// Idempotent DDL — ensures the knowledge base exists. Runs on first search.
// Uses pgvector (Neon) / lakebase_vector (Lakebase) patterns; falls back
// gracefully if the vector extension is unavailable (text search still works).
let ensured = false;
export async function ensureKnowledgeBase(): Promise<void> {
  if (ensured) return;
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch {
    // Vector extension unavailable; text search will still work.
  }
  await sql`
    CREATE TABLE IF NOT EXISTS public.setup_knowledge (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      tags TEXT[] NOT NULL DEFAULT '{}',
      embedding vector(1536),
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_setup_knowledge_search
    ON public.setup_knowledge USING gin (search_vector)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_setup_knowledge_category
    ON public.setup_knowledge (category)
  `;
  // HNSW index — may fail if pgvector is old or extension missing; non-fatal.
  try {
    await sql`
      CREATE INDEX IF NOT EXISTS idx_setup_knowledge_embedding
      ON public.setup_knowledge USING hnsw (embedding vector_cosine_ops)
    `;
  } catch {
    /* vector index optional */
  }
  ensured = true;
}

/**
 * Seed the knowledge base (idempotent: clears and re-inserts curated entries).
 * Call once via the admin endpoint after deploy.
 */
export async function seedKnowledgeBase(): Promise<number> {
  await ensureKnowledgeBase();
  await sql`DELETE FROM public.setup_knowledge`;
  for (const entry of SETUP_KNOWLEDGE) {
    await sql`
      INSERT INTO public.setup_knowledge (title, body, category, tags)
      VALUES (${entry.title}, ${entry.body}, ${entry.category}, ${entry.tags})
    `;
  }
  return SETUP_KNOWLEDGE.length;
}

/**
 * Search the knowledge base. `embedding` is optional — when absent,
 * falls back to pure full-text search (still useful).
 */
export async function searchSetupKnowledge(
  query: string,
  embedding: number[] | null,
  limit: number = 5
): Promise<KnowledgeHit[]> {
  if (!query || !query.trim()) return [];

  // Ensure the table exists (idempotent, first-call only).
  try {
    await ensureKnowledgeBase();
  } catch (e) {
    console.warn("[knowledge] ensure failed:", (e as any)?.message);
    return [];
  }

  // Full-text query: plainto_tsquery handles natural language safely.
  const textResults = (await sql`
    SELECT id, title, body, category, tags,
           ts_rank(search_vector, plainto_tsquery('english', ${query})) AS score
    FROM public.setup_knowledge
    WHERE search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY score DESC
    LIMIT 20
  `.catch(() => [])) as KnowledgeHit[];

  let vectorResults: { id: number; score: number }[] = [];
  if (embedding && embedding.length > 0) {
    const vecLiteral = `[${embedding.join(",")}]`;
    vectorResults = (await sql`
      SELECT id, 1 - (embedding <=> ${vecLiteral}::vector) AS score
      FROM public.setup_knowledge
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT 20
    `.catch(() => [])) as { id: number; score: number }[];
  }

  // Reciprocal Rank Fusion (k=60, standard)
  const K = 60;
  const fused = new Map<number, number>();
  textResults.forEach((r, i) => {
    fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (K + i + 1));
  });
  vectorResults.forEach((r, i) => {
    fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (K + i + 1));
  });

  const ranked: [number, number][] = Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (ranked.length === 0) return [];

  const byId = new Map(textResults.map((r) => [r.id, r]));
  // Fetch any vector-only hits not in textResults
  const missingIds = ranked.map(([id]) => id).filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const rows = (await sql`
      SELECT id, title, body, category, tags, 0 AS score
      FROM public.setup_knowledge
      WHERE id = ANY(${missingIds})
    `.catch(() => [])) as KnowledgeHit[];
    rows.forEach((r) => byId.set(r.id, r));
  }

  return ranked
    .map(([id, score]) => {
      const hit = byId.get(id);
      return hit ? { ...hit, score } : null;
    })
    .filter((h): h is KnowledgeHit => h !== null);
}

/**
 * Build a retrieval-augmented context block for the AI prompt.
 * Called with the driver's complaint + detected handling issues.
 */
export async function getKnowledgeContext(
  queryParts: string[],
  embedding: number[] | null = null,
  limit: number = 3
): Promise<string> {
  const query = queryParts.filter(Boolean).join(" ").slice(0, 500);
  if (!query.trim()) return "";

  const hits = await searchSetupKnowledge(query, embedding, limit);
  if (hits.length === 0) return "";

  return (
    `\n=== RETRIEVED SETUP KNOWLEDGE (use to ground your recommendations) ===\n` +
    hits
      .map((h, i) => `[${i + 1}] ${h.title} (${h.category})\n${h.body}`)
      .join("\n\n")
  );
}
