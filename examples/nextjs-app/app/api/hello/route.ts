import { withLogSetu } from "logsetu-js/next";

export const GET = withLogSetu(async () => Response.json({ ok: true }), { logRequests: true });
