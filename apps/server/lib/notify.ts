// Delivery for alert notifications: generic webhook (JSON), Slack incoming webhook, email (SMTP).

export const ALERT_CHANNELS = ["webhook", "slack", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type Notification = {
  title: string; // one line, e.g. "[LogSetu] acme-storefront: Error spike"
  text: string; // plain-text body
  url: string | null; // deep link into the dashboard
  payload: Record<string, unknown>; // structured data for webhooks
};

const TIMEOUT_MS = 10_000;

/** Base URL for dashboard links in notifications. */
export function publicUrl(): string | null {
  const u = process.env.LOGSETU_PUBLIC_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.LOGSETU_SMTP_URL);
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "LogSetu-Alerts" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

function slackBody(n: Notification) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    text: n.title, // notification fallback
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escape(n.title)}*\n${escape(n.text)}` } },
      ...(n.url
        ? [
            {
              type: "actions",
              elements: [{ type: "button", text: { type: "plain_text", text: "Open in LogSetu" }, url: n.url }],
            },
          ]
        : []),
    ],
  };
}

async function sendEmail(to: string, n: Notification) {
  const url = process.env.LOGSETU_SMTP_URL;
  if (!url) throw new Error("Email is not configured (set LOGSETU_SMTP_URL)");
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({
    from: process.env.LOGSETU_SMTP_FROM || "LogSetu <logsetu@localhost>",
    to,
    subject: n.title,
    text: n.url ? `${n.text}\n\n${n.url}` : n.text,
  });
}

export async function deliver(channel: string, target: string, n: Notification): Promise<void> {
  switch (channel) {
    case "webhook":
      return postJson(target, { title: n.title, text: n.text, url: n.url, ...n.payload });
    case "slack":
      return postJson(target, slackBody(n));
    case "email":
      return sendEmail(target, n);
    default:
      throw new Error(`Unknown channel "${channel}"`);
  }
}
