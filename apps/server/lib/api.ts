import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function error(status: number, message: string, details?: unknown) {
  return NextResponse.json({ error: message, ...(details !== undefined ? { details } : {}) }, { status });
}

export function zodError(err: ZodError) {
  return error(400, "Validation failed", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

export function searchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  sp.forEach((v, k) => {
    if (v !== "") out[k] = v;
  });
  return out;
}
