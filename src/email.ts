// Podium email: IMAP inbox view per pod, built on Relay's zero-dep IMAP
// client (src/imap.ts, copied verbatim — credit Relay in README).
// The IMAP functions are dependency-injected so tests can stub them;
// no sockets are opened in tests.
import {
  latestEmailWith, fetchInboxBody, validateImap,
  type ImapConfig, type EmailContext,
} from "./imap";

export interface InboxItem {
  person_id: string;
  person_name: string;
  email: string;
  mailbox: "inbox" | "sent";
  uid: string;
  from: string;
  subject: string;
  date: string; // ISO
  direction: "in" | "out";
  snippet: string;
  body: string; // plain text, up to maxBodyChars at fetch time
}

export interface InboxMember {
  person_id: string;
  person_name: string;
  person_email: string;
}

export interface EmailDeps {
  latest?: (cfg: ImapConfig, email: string) => Promise<EmailContext | null>;
  body?: (cfg: ImapConfig, uid: string, maxChars?: number) => Promise<string>;
  validate?: (cfg: ImapConfig) => Promise<{ ok: true }>;
}

const realDeps: EmailDeps = { latest: latestEmailWith, body: fetchInboxBody, validate: validateImap };

export function imapConfigured(getSetting: (k: string) => string): boolean {
  return !!(getSetting("imap_host") && getSetting("imap_user") && getSetting("imap_pass"));
}

export function imapConfigFromSettings(getSetting: (k: string) => string): ImapConfig {
  const port = Number(getSetting("imap_port")) || 993;
  return {
    host: getSetting("imap_host"),
    port,
    user: getSetting("imap_user"),
    pass: getSetting("imap_pass"),
  };
}

function toItem(m: InboxMember, ctx: EmailContext): InboxItem {
  const body = ctx.body || "";
  return {
    person_id: m.person_id,
    person_name: m.person_name,
    email: m.person_email,
    mailbox: ctx.mailbox,
    uid: ctx.uid,
    from: ctx.from,
    subject: ctx.subject,
    date: ctx.date,
    direction: ctx.direction,
    snippet: body.slice(0, 220).replace(/\s+/g, " ").trim(),
    body,
  };
}

// ---------- 5-minute in-memory cache, keyed by pod ----------
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry { at: number; items: InboxItem[]; }
const cache = new Map<string, CacheEntry>();

export function clearInboxCache(podId?: string): void {
  if (podId) cache.delete(podId);
  else cache.clear();
}

/**
 * Recent email with each pod member (members without an email are skipped).
 * Results are cached 5 minutes per pod; pass force:true to re-fetch.
 * Throws {status:400} when IMAP is not configured.
 */
export async function getPodInbox(
  podId: string,
  members: InboxMember[],
  getSetting: (k: string) => string,
  opts: { force?: boolean; deps?: EmailDeps } = {},
): Promise<{ items: InboxItem[]; cached: boolean; cachedAt: string | null }> {
  if (!imapConfigured(getSetting)) {
    throw Object.assign(new Error("IMAP is not configured — add your mailbox in Settings"), { status: 400 });
  }
  const hit = cache.get(podId);
  if (hit && !opts.force && Date.now() - hit.at < CACHE_TTL_MS) {
    return { items: hit.items, cached: true, cachedAt: new Date(hit.at).toISOString() };
  }
  const deps = { ...realDeps, ...(opts.deps || {}) };
  const cfg = imapConfigFromSettings(getSetting);
  const withEmail = members.filter((m) => m.person_email && m.person_email.includes("@"));
  const settled = await Promise.allSettled(
    withEmail.map(async (m): Promise<InboxItem | null> => {
      const ctx = await deps.latest!(cfg, m.person_email);
      return ctx ? toItem(m, ctx) : null;
    }),
  );
  const items = settled
    .filter((s): s is PromiseFulfilledResult<InboxItem | null> => s.status === "fulfilled")
    .map((s) => s.value)
    .filter((i): i is InboxItem => !!i)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  cache.set(podId, { at: Date.now(), items });
  return { items, cached: false, cachedAt: null };
}

/**
 * Full body for one cached inbox item. Inbox items are re-fetched at higher
 * fidelity; sent items reuse the body captured by latestEmailWith.
 */
export async function getInboxBody(
  podId: string,
  uid: string,
  getSetting: (k: string) => string,
  opts: { deps?: EmailDeps } = {},
): Promise<{ body: string; subject: string; from: string; date: string }> {
  if (!imapConfigured(getSetting)) {
    throw Object.assign(new Error("IMAP is not configured — add your mailbox in Settings"), { status: 400 });
  }
  const hit = cache.get(podId);
  const item = hit?.items.find((i) => i.uid === uid);
  if (!item) throw Object.assign(new Error("message not found — refresh the inbox"), { status: 404 });
  if (item.mailbox === "sent") {
    return { body: item.body, subject: item.subject, from: item.from, date: item.date };
  }
  const deps = { ...realDeps, ...(opts.deps || {}) };
  const cfg = imapConfigFromSettings(getSetting);
  const body = await deps.body!(cfg, item.uid, 8000);
  return { body, subject: item.subject, from: item.from, date: item.date };
}

export async function testImap(
  getSetting: (k: string) => string,
  opts: { deps?: EmailDeps } = {},
): Promise<{ ok: true }> {
  if (!imapConfigured(getSetting)) {
    throw Object.assign(new Error("IMAP is not configured — add your mailbox in Settings"), { status: 400 });
  }
  const deps = { ...realDeps, ...(opts.deps || {}) };
  return deps.validate!(imapConfigFromSettings(getSetting));
}

/**
 * Canned IMAP stubs for server tests (PODIUM_MOCK_EMAIL=1). No sockets.
 * Returns deterministic per-address threads.
 */
export function mockEmailDeps(): EmailDeps {
  return {
    latest: async (_cfg: ImapConfig, email: string) => ({
      mailbox: "inbox" as const,
      uid: "uid-" + email,
      messageId: "<" + email + ">",
      from: "Sender <" + email + ">",
      subject: "Re: Q3 planning — " + email,
      date: new Date(Date.now() - 3600_000).toISOString(),
      body: "Hi there — following up on our thread. ".repeat(30),
      direction: "in" as const,
    }),
    body: async (_cfg: ImapConfig, uid: string, _max?: number) =>
      "Full message body for " + uid + ". " + "Lorem ipsum dolor sit amet. ".repeat(40),
    validate: async (_cfg: ImapConfig) => ({ ok: true as const }),
  };
}
