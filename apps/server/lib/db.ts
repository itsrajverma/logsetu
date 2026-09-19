import { PrismaClient as SqliteClient } from "@/generated/sqlite/client";
import { PrismaClient as PostgresClient } from "@/generated/postgres/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

export type Db = SqliteClient;

const DEFAULT_SQLITE_URL = "file:./data/logsetu.db";

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_SQLITE_URL;
}

export function isPostgres(url = getDatabaseUrl()): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

function createClient(): Db {
  const url = getDatabaseUrl();
  if (isPostgres(url)) {
    const adapter = new PrismaPg({ connectionString: url });
    // Both generated clients share identical models; the SQLite type is used as the common interface.
    return new PostgresClient({ adapter }) as unknown as Db;
  }
  const file = url.replace(/^file:/, "");
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const adapter = new PrismaBetterSqlite3({ url });
  return new SqliteClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { __logsetuDb?: Db };

export const db: Db = globalForPrisma.__logsetuDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__logsetuDb = db;
