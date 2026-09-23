import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { error, zodError } from "@/lib/api";
import { extractBearer, getProjectFromApiKey } from "@/lib/auth";
import { publishLogs } from "@/lib/events";
import { assignIssues } from "@/lib/grouping";
import { checkRateLimit } from "@/lib/ratelimit";
import { parseIngestBody } from "@/lib/validation";
import type { Prisma } from "@/generated/sqlite/client";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  const project = await getProjectFromApiKey(extractBearer(req));
  if (!project) return withCors(error(401, "Invalid or missing API key"));

  let body: unknown;
  try {
    // Parse from text so text/plain beacons (no CORS preflight) work too.
    body = JSON.parse(await req.text());
  } catch {
    return withCors(error(400, "Body must be JSON"));
  }

  const parsed = parseIngestBody(body);
  if (!parsed.success) return withCors(zodError(parsed.error));
  const entries = parsed.data;

  const rl = checkRateLimit(project.id, entries.length);
  if (!rl.ok) {
    return withCors(error(429, "Rate limit exceeded", { retryAfterSeconds: rl.resetInSeconds }), {
      "Retry-After": String(rl.resetInSeconds),
    });
  }

  const rows: Prisma.LogEntryCreateManyInput[] = entries.map((e) => ({
    projectId: project.id,
    level: e.level,
    message: e.message,
    source: e.source ?? "unknown",
    environment: e.environment ?? "production",
    meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    timestamp: e.timestamp,
  }));

  // Respond 202 immediately; persist after the response is flushed.
  after(async () => {
    try {
      await assignIssues(project.id, rows).catch((e) => console.error("[logsetu] error grouping failed", e));
      const created = await db.logEntry.createManyAndReturn({ data: rows });
      publishLogs(project.id, created);
    } catch (e) {
      console.error("[logsetu] failed to persist batch", e);
    }
  });

  return withCors(NextResponse.json({ accepted: rows.length }, { status: 202 }), {
    "X-RateLimit-Remaining": String(rl.remaining),
  });
}

function withCors(res: NextResponse, extra: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) res.headers.set(k, v);
  return res;
}
