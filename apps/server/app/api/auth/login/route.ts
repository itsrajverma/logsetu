import { NextResponse } from "next/server";
import { error } from "@/lib/api";
import { createSessionToken, isAdminPasswordConfigured, sessionCookieOptions, verifyAdminPassword } from "@/lib/auth";
import { loginSchema } from "@/lib/validation";

export async function POST(req: Request) {
  if (!isAdminPasswordConfigured()) return error(500, "LOGSETU_ADMIN_PASSWORD is not set on the server");
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return error(400, "Password required");
  if (!verifyAdminPassword(parsed.data.password)) return error(401, "Invalid password");

  const res = NextResponse.json({ ok: true });
  const { name, ...opts } = sessionCookieOptions();
  res.cookies.set(name, createSessionToken(), opts);
  return res;
}
