import { error, json } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { getOtlpStatus } from "@/lib/otlp";

export const dynamic = "force-dynamic";

/** OpenTelemetry exporter status: enabled, target, counters and last error (admin). */
export async function GET() {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  return json(getOtlpStatus());
}
