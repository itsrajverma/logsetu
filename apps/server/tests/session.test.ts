import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth";
import { verifySessionTokenEdge } from "@/lib/session-edge";

beforeAll(() => {
  process.env.LOGSETU_ADMIN_PASSWORD = "test-password";
});

describe("admin session tokens", () => {
  it("round-trips through node and edge verifiers", async () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
    expect(await verifySessionTokenEdge(token)).toBe(true);
  });

  it("rejects tampered and expired tokens", async () => {
    const token = createSessionToken();
    const [role, exp, sig] = token.split(".");
    expect(verifySessionToken(`${role}.${Number(exp) + 10}.${sig}`)).toBe(false);
    expect(verifySessionToken(`admin.${Math.floor(Date.now() / 1000) - 10}.${sig}`)).toBe(false);
    expect(await verifySessionTokenEdge("garbage")).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });
});
