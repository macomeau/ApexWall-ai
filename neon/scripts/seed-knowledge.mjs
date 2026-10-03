// Seed the setup_knowledge RAG table.
// Usage: DATABASE_URL=<redacted> node neon/scripts/seed-knowledge.mjs
import { neon } from "@neondatabase/serverless";
import { SETUP_KNOWLEDGE } from "./setup-knowledge-data.mjs";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  // Idempotent: clear and re-seed (knowledge base is curated, not user data)
  await sql`DELETE FROM public.setup_knowledge`;
  console.log("cleared setup_knowledge");

  for (const entry of SETUP_KNOWLEDGE) {
    await sql`
      INSERT INTO public.setup_knowledge (title, body, category, tags)
      VALUES (${entry.title}, ${entry.body}, ${entry.category}, ${entry.tags})
    `;
  }
  console.log(`seeded ${SETUP_KNOWLEDGE.length} entries`);

  const count = await sql`SELECT COUNT(*) AS c FROM public.setup_knowledge`;
  console.log("total rows:", (count as any)[0].c);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
