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

export interface KnowledgeHit {
  id: number;
  title: string;
  body: string;
  category: string;
  tags: string[];
  score: number;
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
