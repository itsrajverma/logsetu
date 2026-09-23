import { z } from "zod";
import { LOG_LEVELS, MAX_BATCH_SIZE, MAX_MESSAGE_LENGTH, MAX_META_BYTES, MAX_PAGE_SIZE } from "./constants";

const levelSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .pipe(z.enum(LOG_LEVELS));

const timestampSchema = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === "") return new Date();
    const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid timestamp" });
      return z.NEVER;
    }
    return d;
  });

const metaSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .nullable()
  .refine((m) => !m || JSON.stringify(m).length <= MAX_META_BYTES, {
    message: `meta must be under ${MAX_META_BYTES} bytes when serialized`,
  });

export const logEntryInputSchema = z.object({
  level: levelSchema.default("info"),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  source: z.string().max(200).optional(),
  environment: z.string().max(100).optional(),
  meta: metaSchema,
  timestamp: timestampSchema,
});

export type LogEntryInput = z.infer<typeof logEntryInputSchema>;

const batchSchema = z.array(logEntryInputSchema).min(1).max(MAX_BATCH_SIZE);
const wrappedSchema = z.object({ logs: batchSchema });

/** Accepts a single log object, an array of logs, or { logs: [...] }. Returns normalized entries. */
export type IngestParseResult = { success: true; data: LogEntryInput[] } | { success: false; error: z.ZodError };

export function parseIngestBody(body: unknown): IngestParseResult {
  if (Array.isArray(body)) return batchSchema.safeParse(body);
  if (body && typeof body === "object" && "logs" in body) {
    const r = wrappedSchema.safeParse(body);
    return r.success ? { success: true, data: r.data.logs } : r;
  }
  const r = logEntryInputSchema.safeParse(body);
  return r.success ? { success: true, data: [r.data] } : r;
}

const dateParam = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" });
      return z.NEVER;
    }
    return d;
  });

export const logsQuerySchema = z.object({
  projectId: z.string().min(1),
  level: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(LOG_LEVELS)).optional()),
  source: z.string().optional(),
  environment: z.string().optional(),
  search: z.string().max(500).optional(),
  issueId: z.string().optional(),
  from: dateParam,
  to: dateParam,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

export type LogsQuery = z.infer<typeof logsQuerySchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  rotateKey: z.boolean().optional(),
  // null = fall back to the server default; omitted = unchanged
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export const issuesQuerySchema = z.object({
  projectId: z.string().min(1),
  status: z.enum(["open", "resolved", "ignored", "all"]).default("open"),
  sort: z.enum(["lastSeen", "firstSeen", "count"]).default("lastSeen"),
  search: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type IssuesQuery = z.infer<typeof issuesQuerySchema>;

export const updateIssueSchema = z.object({
  status: z.enum(["open", "resolved", "ignored"]),
});

const optionalFilter = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

// No defaults here: .partial() would re-apply them and a PATCH would silently reset omitted fields.
const alertRuleFields = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  trigger: z.enum(["threshold", "new_issue"]),
  levels: z.array(z.enum(LOG_LEVELS)).min(1),
  source: optionalFilter,
  environment: optionalFilter,
  threshold: z.number().int().min(1).max(1_000_000),
  windowMinutes: z.number().int().min(1).max(1440),
  cooldownMinutes: z.number().int().min(0).max(10_080),
  channel: z.enum(["webhook", "slack", "email"]),
  target: z.string().trim().min(1).max(2000),
});

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function checkTarget(rule: { channel: string; target: string }, ctx: z.RefinementCtx) {
  if (rule.channel === "email") {
    const bad = rule.target.split(",").map((s) => s.trim()).filter((s) => !EMAIL_RE.test(s));
    if (bad.length) ctx.addIssue({ code: "custom", path: ["target"], message: `Invalid email address: ${bad[0] || "(empty)"}` });
    return;
  }
  try {
    const u = new URL(rule.target);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    ctx.addIssue({ code: "custom", path: ["target"], message: "Must be an http(s) URL" });
  }
}

export const createAlertRuleSchema = alertRuleFields
  .extend({
    projectId: z.string().min(1),
    enabled: alertRuleFields.shape.enabled.default(true),
    trigger: alertRuleFields.shape.trigger.default("threshold"),
    levels: alertRuleFields.shape.levels.default(["error", "fatal"]),
    threshold: alertRuleFields.shape.threshold.default(10),
    windowMinutes: alertRuleFields.shape.windowMinutes.default(5),
    cooldownMinutes: alertRuleFields.shape.cooldownMinutes.default(15),
  })
  .superRefine(checkTarget);

/** Validate a PATCH by merging it onto the stored rule and re-checking the whole thing. */
export const alertRulePatchSchema = alertRuleFields.partial();
export const alertRuleSchema = alertRuleFields.superRefine(checkTarget);

export type AlertRuleInput = z.infer<typeof alertRuleFields>;

export const loginSchema = z.object({
  password: z.string().min(1),
});
