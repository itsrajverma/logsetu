#!/usr/bin/env node
// Generates the next SQL migration for BOTH providers by diffing the schema against the
// previous migrations. Usage: pnpm db:diff add_retention_column
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("usage: pnpm db:diff <migration_name>");
  process.exit(1);
}
for (const provider of ["sqlite", "postgres"]) {
  const dir = path.join("prisma", "migrations", provider);
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const next = `${String(existing.length + 1).padStart(4, "0")}_${name}.sql`;
  // Build a temp "from" schema by replaying existing migrations into a scratch SQLite/Postgres is
  // heavy; instead diff from the previous *schema snapshot* kept next to the migrations.
  const snapshot = path.join(dir, "_schema.snapshot.prisma");
  const from = fs.existsSync(snapshot) ? `--from-schema ${snapshot}` : "--from-empty";
  const schema = `prisma/${provider}/schema.prisma`;
  const sql = execSync(`pnpm exec prisma migrate diff ${from} --to-schema ${schema} --script`, { encoding: "utf8" });
  if (!sql.trim() || /This is an empty migration/.test(sql)) {
    console.log(`[${provider}] no changes`);
    continue;
  }
  fs.writeFileSync(path.join(dir, next), sql);
  fs.copyFileSync(schema, snapshot);
  console.log(`[${provider}] wrote ${next}`);
}
