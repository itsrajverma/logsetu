import { db, isPostgres } from "@/lib/db";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.project.count();
    return json({ ok: true, database: isPostgres() ? "postgres" : "sqlite", version: process.env.LOGSETU_VERSION ?? "dev" });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
