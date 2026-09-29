// One-off migration runner: applies a .sql file statement-by-statement.
// Usage: DATABASE_URL=... node neon/scripts/run-migration.mjs <file.sql>
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: run-migration.mjs <file.sql>");
  process.exit(1);
}

const raw = fs.readFileSync(file, "utf8");
// Strip line comments, then split into statements on semicolons.
const lines = raw.split("\n").map((l) => {
  const idx = l.indexOf("--");
  return idx >= 0 ? l.slice(0, idx) : l;
});
const stripped = lines.join("\n");
const stmts = stripped
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const sql = neon(process.env.DATABASE_URL);
for (const s of stmts) {
  await sql.query(s);
  console.log("applied:", s.slice(0, 70).replace(/\s+/g, " "));
}
console.log("migration OK:", file);
