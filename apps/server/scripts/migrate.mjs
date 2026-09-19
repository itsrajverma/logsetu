#!/usr/bin/env node
// Applies the plain-SQL migrations in prisma/migrations/{sqlite,postgres} in order, once each.
// Used at container start so the runtime image doesn't need the Prisma CLI.
// Contributors: after changing schema.prisma, run `pnpm db:diff <name>` to generate the next file.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve a dependency from the app dir, falling back to pnpm's hoisted store as laid out in the
// Next.js standalone output (node_modules/.pnpm/node_modules/<pkg>).
function load(name) {
  const candidates = [here];
  for (let dir = here; ; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, "node_modules", ".pnpm", "node_modules"));
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of candidates) {
    try {
      return createRequire(path.join(dir, "noop.js"))(name);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
  throw new Error(`[logsetu:migrate] cannot find module '${name}'`);
}
const url = process.env.DATABASE_URL?.trim() || "file:./data/logsetu.db";
const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");
const dir = path.join(here, "..", "prisma", "migrations", isPostgres ? "postgres" : "sqlite");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const log = (m) => console.log(`[logsetu:migrate] ${m}`);

if (isPostgres) {
  const { Client } = load("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS "_logsetu_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query(`SELECT "name" FROM "_logsetu_migrations"`);
    const applied = new Set(rows.map((r) => r.name));
    // Baseline: schema created by `prisma db push` (dev) before this migrator existed.
    if (applied.size === 0) {
      const { rows: t } = await client.query(`SELECT to_regclass('"Project"') AS t`);
      if (t[0]?.t) {
        await client.query(`INSERT INTO "_logsetu_migrations" ("name") VALUES ($1)`, [files[0]]);
        applied.add(files[0]);
        log(`baselined existing schema as ${files[0]}`);
      }
    }
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO "_logsetu_migrations" ("name") VALUES ($1)`, [f]);
        await client.query("COMMIT");
        log(`applied ${f}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
} else {
  const Database = load("better-sqlite3");
  const file = url.replace(/^file:/, "");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS "_logsetu_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set(db.prepare(`SELECT "name" FROM "_logsetu_migrations"`).all().map((r) => r.name));
  if (applied.size === 0 && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='Project'`).get()) {
    db.prepare(`INSERT INTO "_logsetu_migrations" ("name") VALUES (?)`).run(files[0]);
    applied.add(files[0]);
    log(`baselined existing schema as ${files[0]}`);
  }
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO "_logsetu_migrations" ("name") VALUES (?)`).run(f);
    })();
    log(`applied ${f}`);
  }
  db.close();
}
log(`database up to date (${isPostgres ? "postgres" : "sqlite"})`);
