import { error, searchParamsToObject, zodError } from "@/lib/api";
import { authorizeRead } from "@/lib/auth";
import { subscribeLogs } from "@/lib/events";
import { matchesQuery, type LogRecord } from "@/lib/logs";
import { logsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events stream of newly ingested logs. Accepts the same filters as GET /api/v1/logs
 * (projectId, level, source, environment, search, from, to). Emits `event: logs` with a JSON array.
 */
export async function GET(req: Request) {
  const auth = await authorizeRead(req);
  if (!auth.ok) return error(401, "Unauthorized");

  const raw = searchParamsToObject(new URL(req.url).searchParams);
  if (auth.restrictToProject) raw.projectId = auth.restrictToProject;
  const parsed = logsQuerySchema.safeParse(raw);
  if (!parsed.success) return zodError(parsed.error);
  const q = parsed.data;

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\nevent: ready\ndata: {}\n\n`);

      const unsubscribe = subscribeLogs(q.projectId, (logs: LogRecord[]) => {
        const matching = logs.filter((l) => matchesQuery(l, q));
        if (matching.length > 0) send(`event: logs\ndata: ${JSON.stringify(matching)}\n\n`);
      });
      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
    },
  });
}
