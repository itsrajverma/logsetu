import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./constants";

// ---------- API key auth (SDK ingestion) ----------

export function generateApiKey(): string {
  return `ls_${randomBytes(24).toString("base64url")}`;
}

type CachedProject = { id: string; name: string; expires: number };
const keyCache = new Map<string, CachedProject | null>();
const KEY_CACHE_TTL = 30_000;

export function invalidateApiKeyCache(apiKey?: string) {
  if (apiKey) keyCache.delete(apiKey);
  else keyCache.clear();
}

export async function getProjectFromApiKey(
  apiKey: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
  if (!apiKey) return null;
  const cached = keyCache.get(apiKey);
  if (cached !== undefined && (cached === null || cached.expires > Date.now())) {
    return cached ? { id: cached.id, name: cached.name } : null;
  }
  const project = await db.project.findUnique({ where: { apiKey }, select: { id: true, name: true } });
  keyCache.set(apiKey, project ? { ...project, expires: Date.now() + KEY_CACHE_TTL } : null);
  return project;
}

/** Bearer header, X-Api-Key header, or ?apiKey= query (used by navigator.sendBeacon, which cannot set headers). */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m?.[1]) return m[1].trim();
  const header = req.headers.get("x-api-key");
  if (header) return header;
  try {
    return new URL(req.url).searchParams.get("apiKey");
  } catch {
    return null;
  }
}

// ---------- Admin session (dashboard) ----------

function getSecret(): string {
  const explicit = process.env.LOGSETU_SECRET;
  const pw = process.env.LOGSETU_ADMIN_PASSWORD ?? "";
  return explicit && explicit.length > 0 ? explicit : `logsetu:${pw}`;
}

export function isAdminPasswordConfigured(): boolean {
  return Boolean(process.env.LOGSETU_ADMIN_PASSWORD);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function verifyAdminPassword(candidate: string): boolean {
  const expected = process.env.LOGSETU_ADMIN_PASSWORD;
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function createSessionToken(): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [role, expStr, sig] = parts;
  if (role !== "admin" || !expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(sig, sign(`${role}.${expStr}`));
}

export async function isAdminRequest(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.LOGSETU_SECURE_COOKIES === "1",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Authorize a read/admin API call. Either the dashboard admin (cookie) or an SDK/CLI
 * using a project API key. Returns the project id the caller is restricted to (null = admin).
 */
export async function authorizeRead(
  req: Request,
): Promise<{ ok: true; restrictToProject: string | null } | { ok: false }> {
  if (await isAdminRequest()) return { ok: true, restrictToProject: null };
  const project = await getProjectFromApiKey(extractBearer(req));
  if (project) return { ok: true, restrictToProject: project.id };
  return { ok: false };
}
