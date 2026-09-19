import "dotenv/config";
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL ?? "file:./data/logsetu.db";
const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

export default defineConfig({
  schema: isPostgres ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma",
  datasource: { url },
});
