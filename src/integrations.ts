// Podium integrations: Stripe, Slack, QuickBooks Online.
// Pure HTTP clients — no DB imports, so they stay unit-testable.
// The fetch implementation is swappable via globalThis.__podiumFetch
// (the server installs a mock when PODIUM_MOCK_INTEGRATIONS=1).

import { createHmac, timingSafeEqual } from "node:crypto";

type FetchImpl = (url: string, init?: any) => Promise<Response>;
const http = (): FetchImpl => (globalThis as any).__podiumFetch || globalThis.fetch;

async function readJson(r: Response): Promise<any> {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
}

// ---------- Stripe ----------
const STRIPE_API = "https://api.stripe.com/v1";

export function stripeHeaders(secret: string): Record<string, string> {
  return {
    Authorization: "Basic " + Buffer.from(secret + ":").toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function stripeReq(secret: string, method: string, path: string, params: Record<string, string | number> = {}): Promise<any> {
  if (!secret) throw Object.assign(new Error("Stripe is not connected — add a secret key in Settings"), { status: 400 });
  const body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const r = await http()(STRIPE_API + path, {
    method,
    headers: stripeHeaders(secret),
    body: method === "GET" ? undefined : body,
  });
  const j = await readJson(r);
  if (!r.ok || j?.error) throw new Error(j?.error?.message || `Stripe ${path} failed (${r.status})`);
  return j;
}

export const stripeCreateCustomer = (secret: string, p: { name: string; email?: string }) =>
  stripeReq(secret, "POST", "/customers", { name: p.name, ...(p.email ? { email: p.email } : {}) });

export const stripeCreatePrice = (secret: string, p: { amount_cents: number; nickname: string }) =>
  stripeReq(secret, "POST", "/prices", {
    unit_amount: p.amount_cents, currency: "usd", nickname: p.nickname,
    "recurring[interval]": "month", "product_data[name]": p.nickname,
  });

export const stripeCreateSubscription = (secret: string, p: { customer: string; price: string }) =>
  stripeReq(secret, "POST", "/subscriptions", { customer: p.customer, "items[0][price]": p.price });

export const stripeCreateInvoiceItem = (secret: string, p: { customer: string; amount_cents: number; description: string }) =>
  stripeReq(secret, "POST", "/invoiceitems", {
    customer: p.customer, currency: "usd",
    unit_amount: p.amount_cents, quantity: 1, description: p.description,
  });

export const stripeCreateInvoice = (secret: string, p: { customer: string; metadata?: Record<string, string> }) => {
  const params: Record<string, string> = {
    customer: p.customer, collection_method: "send_invoice", days_until_due: "14", auto_advance: "true",
  };
  for (const [k, v] of Object.entries(p.metadata || {})) params[`metadata[${k}]`] = v;
  return stripeReq(secret, "POST", "/invoices", params);
};

export const stripeFinalizeInvoice = (secret: string, invoiceId: string) =>
  stripeReq(secret, "POST", `/invoices/${invoiceId}/finalize`, {});

/** Stripe Connect transfer — the payout rail. Only called when live payouts are armed. */
export const stripeCreateTransfer = (secret: string, p: { amount_cents: number; destination: string; description: string }) =>
  stripeReq(secret, "POST", "/transfers", {
    amount: p.amount_cents, currency: "usd",
    destination: p.destination, description: p.description.slice(0, 500),
  });

/**
 * Verify a Stripe webhook signature. Stripe-Signature looks like
 * "t=1492774577,v1=5257a869...". Returns false on any mismatch.
 */
export function verifyStripeWebhook(rawBody: string, sigHeader: string, secret: string, maxAgeSec = 300): boolean {
  if (!sigHeader || !secret) return false;
  const t = /t=(\d+)/.exec(sigHeader)?.[1];
  const v1 = /v1=([a-f0-9]+)/.exec(sigHeader)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > maxAgeSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Slack ----------
const SLACK_API = "https://slack.com/api";

export async function slackApi(token: string, method: string, body: Record<string, any> = {}): Promise<any> {
  if (!token) throw Object.assign(new Error("Slack is not connected — add a bot token in Settings"), { status: 400 });
  const r = await http()(SLACK_API + "/" + method, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await readJson(r);
  if (!j?.ok) {
    const e: any = new Error(`Slack ${method} failed: ${j?.error || r.status}`);
    e.slackError = j?.error;
    throw e;
  }
  return j;
}

export const slackCreateChannel = (token: string, name: string) =>
  slackApi(token, "conversations.create", { name, is_private: true });

export const slackListChannels = (token: string) =>
  slackApi(token, "conversations.list", { types: "private_channel", limit: 1000 });

export const slackLookupUser = (token: string, email: string) =>
  slackApi(token, "users.lookupByEmail", { email });

export const slackInvite = (token: string, channel: string, userIds: string[]) =>
  slackApi(token, "conversations.invite", { channel, users: userIds.join(",") });

export const slackPost = (token: string, channel: string, text: string) =>
  slackApi(token, "chat.postMessage", { channel, text });

// ---------- QuickBooks Online ----------
const QBO_AUTH = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export function qboAuthUrl(p: { clientId: string; redirectUri: string; state?: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: p.redirectUri,
    response_type: "code",
    state: p.state || "podium",
  });
  return QBO_AUTH + "?" + q.toString();
}

async function qboTokenReq(p: { clientId: string; clientSecret: string; grant: Record<string, string> }): Promise<any> {
  const r = await http()(QBO_TOKEN, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(p.clientId + ":" + p.clientSecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(p.grant).toString(),
  });
  const j = await readJson(r);
  if (!r.ok || j?.error) throw new Error(j?.error_description || j?.error || `QBO token failed (${r.status})`);
  return j;
}

export const qboExchangeCode = (p: { clientId: string; clientSecret: string; code: string; redirectUri: string }) =>
  qboTokenReq({ clientId: p.clientId, clientSecret: p.clientSecret, grant: { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri } });

export const qboRefresh = (p: { clientId: string; clientSecret: string; refreshToken: string }) =>
  qboTokenReq({ clientId: p.clientId, clientSecret: p.clientSecret, grant: { grant_type: "refresh_token", refresh_token: p.refreshToken } });

export function qboBaseUrl(sandbox: boolean): string {
  return sandbox ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}

export async function qboReq(opts: { baseUrl: string; realmId: string; accessToken: string; method: string; path: string; body?: any }): Promise<any> {
  const url = `${opts.baseUrl}/v3/company/${opts.realmId}/${opts.path}`;
  const r = await http()(url, {
    method: opts.method,
    headers: { Authorization: "Bearer " + opts.accessToken, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const j = await readJson(r);
  if (!r.ok || j?.fault) throw new Error(j?.fault?.error?.[0]?.message || `QBO ${opts.path} failed (${r.status})`);
  return j;
}

/** Build the QBO Invoice payload from one of ours. */
export function buildQboInvoice(inv: {
  number: string; period_start: string; period_end: string; due_at: string | null;
  line_items: { description?: string; person_name?: string; hours?: number; rate_cents?: number; amount_cents: number }[];
}, customerId: string): any {
  return {
    DocNumber: inv.number,
    TxnDate: inv.period_end,
    DueDate: inv.due_at || inv.period_end,
    CustomerRef: { value: customerId },
    Line: inv.line_items.map((l, i) => ({
      Id: String(i + 1),
      Amount: Math.round(l.amount_cents) / 100,
      DetailType: "SalesItemLineDetail",
      Description: l.description || `${l.person_name || "Services"} — ${l.hours || 0}h`,
      SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" } },
    })),
  };
}
