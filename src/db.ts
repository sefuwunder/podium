// Podium persistence: Bun's built-in SQLite.
// Money is integer cents everywhere. The DB lives in gitignored ./data.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = process.env.PODIUM_DATA || new URL("../data", import.meta.url).pathname;
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DATA_DIR + "/podium.db");
db.exec("PRAGMA journal_mode = WAL;");

export const MAX_MEMBERS = 9; // pods stay intimate: under 10
export const MAX_STAGED = 32;
export const STAGE_DAYS = 14;

const nowIso = () => new Date().toISOString();
export const uid = () =>
  (globalThis.crypto as any)?.randomUUID
    ? (globalThis.crypto as any).randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, client_name TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#c96f4a', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pod_members (
      pod_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      UNIQUE(pod_id, person_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
      thread_parent_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, title TEXT NOT NULL,
      body_md TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL, pod_id TEXT NOT NULL,
      day TEXT NOT NULL, hours REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
      billable INTEGER NOT NULL DEFAULT 1, period_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_time_person_day ON time_entries(person_id, day);
    CREATE INDEX IF NOT EXISTS idx_time_pod_day ON time_entries(pod_id, day);
    CREATE TABLE IF NOT EXISTS pay_periods (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, start_day TEXT NOT NULL, end_day TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', closed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pay_statements (
      id TEXT PRIMARY KEY, period_id TEXT NOT NULL, person_id TEXT NOT NULL, pod_id TEXT NOT NULL,
      hours REAL NOT NULL, rate_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_statements_period ON pay_statements(period_id);

    -- v1 integrations: CRM, templates, timers, scheduling, invoices, settings
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
      temperature TEXT NOT NULL DEFAULT 'warm', priority INTEGER NOT NULL DEFAULT 3,
      value_cents INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'intro',
      notes TEXT NOT NULL DEFAULT '', partner_id TEXT, booking_id TEXT, pod_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other',
      contact_name TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'doc',
      body_md TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL, pod_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS availability (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL, weekday INTEGER NOT NULL,
      start_min INTEGER NOT NULL, end_min INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL, lead_id TEXT,
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
      booker_name TEXT NOT NULL DEFAULT '', booker_email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_person ON bookings(person_id, start_at);
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, pod_id TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, line_items TEXT NOT NULL DEFAULT '[]',
      hours REAL NOT NULL DEFAULT 0, amount_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', stripe_invoice_id TEXT, qbo_id TEXT,
      due_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    -- Phase 3: billing clearinghouse & automated distribution
    CREATE TABLE IF NOT EXISTS billing_runs (
      id TEXT PRIMARY KEY, run_month TEXT NOT NULL UNIQUE, ran_at TEXT NOT NULL,
      invoice_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, person_id TEXT NOT NULL,
      gross_cents INTEGER NOT NULL, spread_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', stripe_transfer_id TEXT,
      failure TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE(invoice_id, person_id)
    );
    CREATE TABLE IF NOT EXISTS distributions (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE, ran_at TEXT NOT NULL,
      mode TEXT NOT NULL, spread_pct REAL NOT NULL, created_at TEXT NOT NULL
    );
    -- Phase 1: talent & pod allocation engine
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conflicts_person ON conflicts(person_id);
    -- Phase 2: client portal & value-log engine
    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, title TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '', progress_pct INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'on_track', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_objectives_pod ON objectives(pod_id);
    CREATE TABLE IF NOT EXISTS key_results (
      id TEXT PRIMARY KEY, objective_id TEXT NOT NULL, title TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '', current TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_key_results_objective ON key_results(objective_id);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, kind TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_pod ON alerts(pod_id, created_at);
    CREATE TABLE IF NOT EXISTS page_signings (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      signer_name TEXT NOT NULL DEFAULT '', signer_email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', signed_at TEXT,
      signature_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signings_page ON page_signings(page_id);
  `);
  // Column migrations for existing installs (PRAGMA-style).
  const ensureColumn = (table: string, name: string, ddl: string) => {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  ensureColumn("pods", "billing_type", "TEXT NOT NULL DEFAULT 'hourly'");
  ensureColumn("pods", "retainer_hours", "REAL");
  ensureColumn("pods", "retainer_rate_cents", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("pods", "slack_channel_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("pods", "stripe_customer_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("pods", "stripe_subscription_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("pods", "clickup_list_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("people", "booking_slug", "TEXT");
  // Phase 1: talent & pod allocation engine
  ensureColumn("people", "max_weekly_hours", "REAL");
  ensureColumn("people", "skills", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("people", "rate_tier", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("people", "bio", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("people", "stripe_connect_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("pod_members", "allocated_hours", "REAL");
  ensureColumn("pods", "match_slug", "TEXT");
  ensureColumn("pods", "match_visible", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("pods", "match_blurb", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pods_match_slug ON pods(match_slug) WHERE match_slug IS NOT NULL");
  // Phase 2: client portal & value-log engine
  ensureColumn("time_entries", "block_type", "TEXT NOT NULL DEFAULT 'hours'");
  ensureColumn("time_entries", "decisions", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("leads", "budget_band", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("leads", "contact_method", "TEXT NOT NULL DEFAULT ''");
  seedTemplates();
}

// ---------- people ----------
export interface Person {
  id: string; name: string; email: string; title: string; hourly_rate_cents: number;
  booking_slug: string | null; created_at: string;
  max_weekly_hours: number | null; skills: string[]; rate_tier: string; bio: string;
  stripe_connect_id: string;
}
export const RATE_TIERS = ["", "I", "II", "III", "$", "$$", "$$$"];
/** Normalize a skills input (array or comma-separated string) → deduped trimmed list. */
export function normalizeSkills(input: unknown): string[] {
  const raw: unknown[] = Array.isArray(input)
    ? input
    : String(input || "").split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const t = String(s || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 24);
}
function parseSkillsJSON(raw: any): string[] {
  try {
    const a = JSON.parse(raw || "[]");
    return normalizeSkills(Array.isArray(a) ? a : []);
  } catch { return []; }
}
function personRow(r: any): Person {
  return { ...r, skills: parseSkillsJSON(r.skills) };
}
function validRateTier(t: unknown): string {
  const tier = String(t || "").trim();
  if (!RATE_TIERS.includes(tier)) throw Object.assign(new Error("rate_tier must be one of I, II, III, $, $$, $$$"), { status: 400 });
  return tier;
}
function validMaxWeeklyHours(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error("max_weekly_hours must be a positive number"), { status: 400 });
  return Math.round(n * 100) / 100;
}
export const listPeople = () =>
  (db.query("SELECT * FROM people ORDER BY name COLLATE NOCASE").all() as any[]).map(personRow);
export const getPerson = (id: string) => {
  const r = db.query("SELECT * FROM people WHERE id = ?").get(id) as any;
  return r ? personRow(r) : null;
};
export function createPerson(p: {
  name: string; email?: string; title?: string; hourly_rate_cents?: number;
  max_weekly_hours?: number | null; skills?: string[] | string; rate_tier?: string; bio?: string;
  stripe_connect_id?: string;
}): Person {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const rate = Math.round(Number(p.hourly_rate_cents) || 0);
  if (rate < 0) throw Object.assign(new Error("hourly_rate_cents must be >= 0"), { status: 400 });
  const row = {
    id: uid(), name: p.name.trim(), email: (p.email || "").trim(), title: (p.title || "").trim(),
    hourly_rate_cents: rate, booking_slug: null as string | null, created_at: nowIso(),
    max_weekly_hours: validMaxWeeklyHours(p.max_weekly_hours),
    skills: JSON.stringify(normalizeSkills(p.skills)),
    rate_tier: validRateTier(p.rate_tier),
    bio: String(p.bio || "").trim().slice(0, 600),
    stripe_connect_id: String(p.stripe_connect_id || "").trim().slice(0, 60),
  };
  db.query("INSERT INTO people (id, name, email, title, hourly_rate_cents, booking_slug, created_at, max_weekly_hours, skills, rate_tier, bio, stripe_connect_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.email, row.title, row.hourly_rate_cents, row.booking_slug, row.created_at,
      row.max_weekly_hours, row.skills, row.rate_tier, row.bio, row.stripe_connect_id);
  return getPerson(row.id)!;
}
export function updatePerson(id: string, p: Partial<Person> & { skills?: string[] | string }): Person | null {
  const cur = getPerson(id); if (!cur) return null;
  const row = {
    name: (p.name ?? cur.name).trim() || cur.name,
    email: (p.email ?? cur.email).trim(),
    title: (p.title ?? cur.title).trim(),
    hourly_rate_cents: p.hourly_rate_cents == null ? cur.hourly_rate_cents : Math.max(0, Math.round(Number(p.hourly_rate_cents) || 0)),
    max_weekly_hours: p.max_weekly_hours === undefined ? cur.max_weekly_hours : validMaxWeeklyHours(p.max_weekly_hours),
    skills: JSON.stringify(p.skills === undefined ? cur.skills : normalizeSkills(p.skills)),
    rate_tier: p.rate_tier === undefined ? cur.rate_tier : validRateTier(p.rate_tier),
    bio: String(p.bio ?? cur.bio).trim().slice(0, 600),
    stripe_connect_id: String(p.stripe_connect_id ?? cur.stripe_connect_id).trim().slice(0, 60),
  };
  db.query("UPDATE people SET name = ?, email = ?, title = ?, hourly_rate_cents = ?, max_weekly_hours = ?, skills = ?, rate_tier = ?, bio = ?, stripe_connect_id = ? WHERE id = ?")
    .run(row.name, row.email, row.title, row.hourly_rate_cents, row.max_weekly_hours, row.skills, row.rate_tier, row.bio, row.stripe_connect_id, id);
  return getPerson(id);
}
export function deletePerson(id: string): boolean {
  db.query("DELETE FROM conflicts WHERE person_id = ?").run(id);
  return db.query("DELETE FROM people WHERE id = ?").run(id).changes > 0;
}

// ---------- pods ----------
export interface Pod {
  id: string; name: string; client_name: string; color: string; created_at: string;
  billing_type: string; retainer_hours: number | null; retainer_rate_cents: number;
  slack_channel_id: string; stripe_customer_id: string; stripe_subscription_id: string;
  clickup_list_id: string;
  match_slug: string | null; match_visible: number; match_blurb: string;
}
export const listPods = () => db.query("SELECT * FROM pods ORDER BY name COLLATE NOCASE").all() as Pod[];
export const getPod = (id: string) => (db.query("SELECT * FROM pods WHERE id = ?").get(id) as Pod) || null;
export function createPod(p: { name: string; client_name?: string; color?: string }): Pod {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const row: Pod = {
    id: uid(), name: p.name.trim(), client_name: (p.client_name || "").trim(), color: p.color || "#c96f4a",
    created_at: nowIso(), billing_type: "hourly", retainer_hours: null, retainer_rate_cents: 0,
    slack_channel_id: "", stripe_customer_id: "", stripe_subscription_id: "",
    clickup_list_id: "",
  };
  db.query("INSERT INTO pods (id, name, client_name, color, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.client_name, row.color, row.created_at);
  createChannel(row.id, "general"); // every pod opens with #general
  return row;
}
export function updatePod(id: string, p: Partial<Pod>): Pod | null {
  const cur = getPod(id); if (!cur) return null;
  db.query("UPDATE pods SET name = ?, client_name = ?, color = ? WHERE id = ?")
    .run((p.name ?? cur.name).trim() || cur.name, (p.client_name ?? cur.client_name).trim(), p.color || cur.color, id);
  return getPod(id);
}
export function deletePod(id: string): boolean {
  db.query("DELETE FROM messages WHERE pod_id = ?").run(id);
  db.query("DELETE FROM pages WHERE pod_id = ?").run(id);
  db.query("DELETE FROM channels WHERE pod_id = ?").run(id);
  db.query("DELETE FROM pod_members WHERE pod_id = ?").run(id);
  db.query("DELETE FROM time_entries WHERE pod_id = ?").run(id);
  db.query("DELETE FROM pay_statements WHERE pod_id = ?").run(id);
  db.query("DELETE FROM timers WHERE pod_id = ?").run(id);
  db.query("DELETE FROM invoices WHERE pod_id = ?").run(id);
  db.query("UPDATE leads SET pod_id = NULL WHERE pod_id = ?").run(id);
  return db.query("DELETE FROM pods WHERE id = ?").run(id).changes > 0;
}

// ---------- members ----------
export interface PodMember {
  pod_id: string; person_id: string; role: string; joined_at: string;
  allocated_hours: number | null; person_name?: string; person_email?: string;
}
export function listMembers(podId: string): PodMember[] {
  return db.query(
    `SELECT m.*, p.name AS person_name, p.email AS person_email FROM pod_members m JOIN people p ON p.id = m.person_id
     WHERE m.pod_id = ? ORDER BY p.name COLLATE NOCASE`
  ).all(podId) as PodMember[];
}
export function countMembers(podId: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM pod_members WHERE pod_id = ?").get(podId) as any).n as number;
}
export function isMember(podId: string, personId: string): boolean {
  return !!(db.query("SELECT 1 FROM pod_members WHERE pod_id = ? AND person_id = ?").get(podId, personId));
}
export function addMember(podId: string, personId: string, role = ""): PodMember {
  if (!getPod(podId)) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!getPerson(personId)) throw Object.assign(new Error("person not found"), { status: 404 });
  if (isMember(podId, personId)) throw Object.assign(new Error("already a member"), { status: 409 });
  if (countMembers(podId) >= MAX_MEMBERS)
    throw Object.assign(new Error(`pods stay intimate — ${MAX_MEMBERS} members maximum`), { status: 409 });
  const row = { pod_id: podId, person_id: personId, role: role.trim(), joined_at: nowIso() };
  db.query("INSERT INTO pod_members (pod_id, person_id, role, joined_at) VALUES (?, ?, ?, ?)").run(row.pod_id, row.person_id, row.role, row.joined_at);
  return row as PodMember;
}
export function removeMember(podId: string, personId: string): boolean {
  return db.query("DELETE FROM pod_members WHERE pod_id = ? AND person_id = ?").run(podId, personId).changes > 0;
}
/** Monthly hours allocated to an exec in a pod. null = auto (even split of retainer). */
export function setMemberAllocation(podId: string, personId: string, hours: number | null): PodMember {
  if (!isMember(podId, personId)) throw Object.assign(new Error("not a member of this pod"), { status: 404 });
  const h = hours == null || (hours as unknown) === "" ? null : Number(hours);
  if (h != null && (!Number.isFinite(h) || h < 0))
    throw Object.assign(new Error("allocated_hours must be a number >= 0"), { status: 400 });
  db.query("UPDATE pod_members SET allocated_hours = ? WHERE pod_id = ? AND person_id = ?")
    .run(h == null ? null : Math.round(h * 100) / 100, podId, personId);
  return listMembers(podId).find((m) => m.person_id === personId)!;
}

// ---------- conflicts of interest ----------
export interface Conflict { id: string; person_id: string; company: string; reason: string; created_at: string; }
export const listConflicts = (personId: string) =>
  db.query("SELECT * FROM conflicts WHERE person_id = ? ORDER BY company COLLATE NOCASE").all(personId) as Conflict[];
export function addConflict(personId: string, p: { company: string; reason?: string }): Conflict {
  if (!getPerson(personId)) throw Object.assign(new Error("person not found"), { status: 404 });
  if (!p.company?.trim()) throw Object.assign(new Error("company is required"), { status: 400 });
  const row: Conflict = {
    id: uid(), person_id: personId, company: p.company.trim(),
    reason: String(p.reason || "").trim().slice(0, 300), created_at: nowIso(),
  };
  db.query("INSERT INTO conflicts (id, person_id, company, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.person_id, row.company, row.reason, row.created_at);
  return row;
}
export function removeConflict(id: string): boolean {
  return db.query("DELETE FROM conflicts WHERE id = ?").run(id).changes > 0;
}
/** Case-insensitive company match against an exec's conflict register. */
export function personConflictsWith(personId: string, company: string): boolean {
  const c = (company || "").trim().toLowerCase();
  if (!c) return false;
  return listConflicts(personId).some((x) => x.company.toLowerCase() === c);
}

// ---------- capacity ----------
export interface CapacityPod { pod_id: string; pod_name: string; allocated_hours: number; }
export interface CapacityRow {
  person_id: string; person_name: string; title: string; email: string;
  skills: string[]; rate_tier: string; bio: string;
  max_weekly_hours: number | null; max_monthly_hours: number | null;
  allocated: number; load_pct: number | null; pod_count: number;
  pods: CapacityPod[]; conflict_count: number;
}
const WEEKS_PER_MONTH = 4.33;
/**
 * Effective monthly allocation for one membership: explicit allocated_hours,
 * else an even split of the pod's retainer cap, else 0 (hourly pods).
 */
export function memberAllocationHours(podId: string, personId: string): number {
  const m = db.query("SELECT allocated_hours FROM pod_members WHERE pod_id = ? AND person_id = ?")
    .get(podId, personId) as { allocated_hours: number | null } | null;
  if (m && m.allocated_hours != null) return Number(m.allocated_hours);
  const pod = getPod(podId);
  if (pod && pod.billing_type === "retainer" && pod.retainer_hours) {
    const n = countMembers(podId);
    if (n > 0) return Math.round((pod.retainer_hours / n) * 100) / 100;
  }
  return 0;
}
export function capacityReport(): CapacityRow[] {
  return listPeople().map((p) => {
    const memberships = db.query("SELECT pod_id FROM pod_members WHERE person_id = ?").all(p.id) as { pod_id: string }[];
    const pods: CapacityPod[] = memberships.map((m) => {
      const pod = getPod(m.pod_id);
      return { pod_id: m.pod_id, pod_name: pod ? pod.name : "?", allocated_hours: memberAllocationHours(m.pod_id, p.id) };
    });
    const allocated = Math.round(pods.reduce((a, x) => a + x.allocated_hours, 0) * 100) / 100;
    const max_monthly_hours = p.max_weekly_hours != null ? Math.round(p.max_weekly_hours * WEEKS_PER_MONTH * 100) / 100 : null;
    const load_pct = max_monthly_hours && max_monthly_hours > 0 ? allocated / max_monthly_hours : null;
    const conflict_count = (db.query("SELECT COUNT(*) AS n FROM conflicts WHERE person_id = ?").get(p.id) as { n: number }).n;
    return {
      person_id: p.id, person_name: p.name, title: p.title, email: p.email,
      skills: p.skills, rate_tier: p.rate_tier, bio: p.bio,
      max_weekly_hours: p.max_weekly_hours, max_monthly_hours,
      allocated, load_pct, pod_count: pods.length, pods, conflict_count,
    };
  });
}

// ---------- dynamic pod builder ----------
export interface BuilderSuggestion {
  person_id: string; person_name: string; title: string; skills: string[];
  rate_tier: string; bio: string; max_weekly_hours: number | null;
  free_hours: number | null; score: number; breakdown: string[]; reasons: string[];
}
/**
 * Rank execs for a client need: +2 per matching skill, +1 when the target
 * hours fit their free capacity. Conflict with exclude_company excludes
 * outright. Rate tier is shown, not scored.
 */
export function suggestPod(p: { skills?: string[] | string; hours?: number; exclude_company?: string }): BuilderSuggestion[] {
  const want = normalizeSkills(p.skills).map((s) => s.toLowerCase());
  const hours = Math.max(0, Number(p.hours) || 0);
  const exclude = (p.exclude_company || "").trim();
  const out: BuilderSuggestion[] = [];
  for (const c of capacityReport()) {
    if (exclude && personConflictsWith(c.person_id, exclude)) continue;
    let score = 0;
    const breakdown: string[] = [];
    const reasons: string[] = [];
    const matched = want.filter((w) => c.skills.some((s) => s.toLowerCase() === w));
    if (matched.length) {
      score += 2 * matched.length;
      breakdown.push(`+${2 * matched.length} skills`);
      const disp = matched.map((m) => c.skills.find((s) => s.toLowerCase() === m) || m);
      reasons.push(`matches ${disp.join(", ")}`);
    }
    const free = c.max_monthly_hours == null ? null : Math.round((c.max_monthly_hours - c.allocated) * 100) / 100;
    if (hours > 0 && (free == null || free >= hours)) {
      score += 1;
      breakdown.push("+1 capacity");
    }
    if (free == null) reasons.push("unlimited capacity");
    else reasons.push(`${free}h free of ${c.max_monthly_hours}h/mo cap`);
    if (c.conflict_count) reasons.push(`${c.conflict_count} conflict${c.conflict_count === 1 ? "" : "s"} on file`);
    out.push({
      person_id: c.person_id, person_name: c.person_name, title: c.title, skills: c.skills,
      rate_tier: c.rate_tier, bio: c.bio, max_weekly_hours: c.max_weekly_hours,
      free_hours: free, score, breakdown, reasons,
    });
  }
  out.sort((a, b) =>
    b.score - a.score ||
    (b.free_hours == null ? 1e9 : b.free_hours) - (a.free_hours == null ? 1e9 : a.free_hours) ||
    a.person_name.localeCompare(b.person_name));
  return out;
}
/** One-click pod creation from builder selections. */
export function buildPod(p: { company: string; allocations: { person_id: string; allocated_hours?: number | null }[] }): { pod: Pod } {
  const company = (p.company || "").trim();
  if (!company) throw Object.assign(new Error("company is required"), { status: 400 });
  if (!Array.isArray(p.allocations) || !p.allocations.length)
    throw Object.assign(new Error("pick at least one exec"), { status: 400 });
  const pod = createPod({ name: `${company} Pod`, client_name: company });
  try {
    for (const a of p.allocations) {
      if (!a || !a.person_id) throw Object.assign(new Error("person_id is required"), { status: 400 });
      addMember(pod.id, a.person_id, "");
      if (a.allocated_hours != null) setMemberAllocation(pod.id, a.person_id, a.allocated_hours);
    }
  } catch (e) {
    deletePod(pod.id); // don't leave a half-built pod behind
    throw e;
  }
  return { pod: getPod(pod.id)! };
}

// ---------- client match portal (permissioned, anonymized) ----------
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomSlugSuffix(n = 8): string {
  let s = "";
  for (let i = 0; i < n; i++) s += SLUG_CHARS[Math.floor(Math.random() * SLUG_CHARS.length)];
  return s;
}
export function enableMatchLink(podId: string, blurb?: string): Pod {
  const pod = getPod(podId);
  if (!pod) throw Object.assign(new Error("pod not found"), { status: 404 });
  let slug = pod.match_slug;
  if (!slug) {
    const base = pod.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "pod";
    slug = `${base}-${randomSlugSuffix()}`;
    let guard = 0;
    while (db.query("SELECT 1 FROM pods WHERE match_slug = ?").get(slug) && guard++ < 20) slug = `${base}-${randomSlugSuffix()}`;
  }
  db.query("UPDATE pods SET match_slug = ?, match_visible = 1, match_blurb = ? WHERE id = ?")
    .run(slug, String(blurb ?? pod.match_blurb ?? "").trim().slice(0, 500), podId);
  return getPod(podId)!;
}
export function revokeMatchLink(podId: string): Pod {
  if (!getPod(podId)) throw Object.assign(new Error("pod not found"), { status: 404 });
  db.query("UPDATE pods SET match_slug = NULL, match_visible = 0 WHERE id = ?").run(podId);
  return getPod(podId)!;
}
export function getPodByMatchSlug(slug: string): Pod | null {
  const r = db.query("SELECT * FROM pods WHERE match_slug = ? AND match_visible = 1").get(slug) as Pod | null;
  return r || null;
}
/** "Ava Reyes" → "Ava R." — never leak full names or emails. */
export function anonymizeName(full: string): string {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]!.toUpperCase()}.`;
}
/** Rate tier → public band. I→$, II→$$, III→$$$. */
export function rateBand(tier: string): string {
  if (tier === "$" || tier === "$$" || tier === "$$$") return tier;
  if (tier === "I") return "$";
  if (tier === "II") return "$$";
  if (tier === "III") return "$$$";
  return "—";
}
export interface AnonMember { display_name: string; title: string; skills: string[]; rate_band: string; bio: string; }
/** Anonymized pod roster for the public match portal. No emails, no full names, no dollar rates. */
export function anonymizedPodMembers(podId: string): AnonMember[] {
  return listMembers(podId).map((m) => {
    const p = getPerson(m.person_id)!;
    return {
      display_name: anonymizeName(p.name),
      title: p.title,
      skills: p.skills,
      rate_band: rateBand(p.rate_tier),
      bio: p.bio,
    };
  });
}
export function matchPortalData(slug: string): { pod: { name: string; blurb: string }; members: AnonMember[] } {
  const pod = getPodByMatchSlug(slug);
  if (!pod) throw Object.assign(new Error("not found"), { status: 404 });
  return { pod: { name: pod.name, blurb: pod.match_blurb || "" }, members: anonymizedPodMembers(pod.id) };
}

// ---------- channels ----------
export interface Channel { id: string; pod_id: string; name: string; created_at: string; }
export const listChannels = (podId: string) =>
  db.query("SELECT * FROM channels WHERE pod_id = ? ORDER BY created_at").all(podId) as Channel[];
export const getChannel = (id: string) => (db.query("SELECT * FROM channels WHERE id = ?").get(id) as Channel) || null;
export function createChannel(podId: string, name: string): Channel {
  if (!getPod(podId)) throw Object.assign(new Error("pod not found"), { status: 404 });
  const clean = name.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-") || "general";
  const row: Channel = { id: uid(), pod_id: podId, name: clean, created_at: nowIso() };
  db.query("INSERT INTO channels (id, pod_id, name, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.pod_id, row.name, row.created_at);
  return row;
}
export function renameChannel(id: string, name: string): Channel | null {
  const cur = getChannel(id); if (!cur) return null;
  const clean = name.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-") || cur.name;
  db.query("UPDATE channels SET name = ? WHERE id = ?").run(clean, id);
  return getChannel(id);
}
export function deleteChannel(id: string): boolean {
  db.query("DELETE FROM messages WHERE channel_id = ?").run(id);
  return db.query("DELETE FROM channels WHERE id = ?").run(id).changes > 0;
}

// ---------- messages ----------
export interface Message { id: string; pod_id: string; channel_id: string; author_id: string; author_name?: string; body_md: string; thread_parent_id: string | null; created_at: string; replies?: Message[]; }
export function listMessages(channelId: string): Message[] {
  const rows = db.query(
    `SELECT m.*, p.name AS author_name FROM messages m LEFT JOIN people p ON p.id = m.author_id
     WHERE m.channel_id = ? ORDER BY m.created_at`
  ).all(channelId) as Message[];
  const byId = new Map(rows.map((r) => [r.id, { ...r, replies: [] as Message[] }]));
  const roots: Message[] = [];
  for (const r of byId.values()) {
    if (r.thread_parent_id && byId.has(r.thread_parent_id)) byId.get(r.thread_parent_id)!.replies!.push(r);
    else roots.push(r);
  }
  return roots;
}
export function createMessage(p: { pod_id: string; channel_id: string; author_id: string; body_md: string; thread_parent_id?: string | null }): Message {
  const ch = getChannel(p.channel_id);
  if (!ch || ch.pod_id !== p.pod_id) throw Object.assign(new Error("channel not found in pod"), { status: 404 });
  if (!getPerson(p.author_id)) throw Object.assign(new Error("author not found"), { status: 404 });
  if (!p.body_md?.trim()) throw Object.assign(new Error("body is required"), { status: 400 });
  if (p.thread_parent_id) {
    const parent = db.query("SELECT * FROM messages WHERE id = ? AND channel_id = ?").get(p.thread_parent_id, p.channel_id) as Message | null;
    if (!parent || parent.thread_parent_id) throw Object.assign(new Error("can only reply one level deep"), { status: 400 });
  }
  const row = { id: uid(), pod_id: p.pod_id, channel_id: p.channel_id, author_id: p.author_id, body_md: p.body_md.trim(), thread_parent_id: p.thread_parent_id || null, created_at: nowIso() };
  db.query("INSERT INTO messages (id, pod_id, channel_id, author_id, body_md, thread_parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.pod_id, row.channel_id, row.author_id, row.body_md, row.thread_parent_id, row.created_at);
  return row as Message;
}

// ---------- pages ----------
export interface Page { id: string; pod_id: string; title: string; body_md: string; updated_by: string; updated_at: string; created_at: string; }
export const listPages = (podId: string) =>
  db.query("SELECT * FROM pages WHERE pod_id = ? ORDER BY updated_at DESC").all(podId) as Page[];
export const getPage = (id: string) => (db.query("SELECT * FROM pages WHERE id = ?").get(id) as Page) || null;
export function createPage(podId: string, p: { title: string; body_md?: string; updated_by?: string }): Page {
  if (!getPod(podId)) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!p.title?.trim()) throw Object.assign(new Error("title is required"), { status: 400 });
  const row: Page = { id: uid(), pod_id: podId, title: p.title.trim(), body_md: p.body_md || "", updated_by: p.updated_by || "", updated_at: nowIso(), created_at: nowIso() };
  db.query("INSERT INTO pages (id, pod_id, title, body_md, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.pod_id, row.title, row.body_md, row.updated_by, row.updated_at, row.created_at);
  return row;
}
export function updatePage(id: string, p: { title?: string; body_md?: string; updated_by?: string }): Page | null {
  const cur = getPage(id); if (!cur) return null;
  const row = { title: (p.title ?? cur.title).trim() || cur.title, body_md: p.body_md ?? cur.body_md, updated_by: p.updated_by ?? cur.updated_by, updated_at: nowIso() };
  db.query("UPDATE pages SET title = ?, body_md = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .run(row.title, row.body_md, row.updated_by, row.updated_at, id);
  return getPage(id);
}
export function deletePage(id: string): boolean {
  return db.query("DELETE FROM pages WHERE id = ?").run(id).changes > 0;
}

// ---------- time entries ----------
export interface TimeEntry { id: string; person_id: string; pod_id: string; day: string; hours: number; note: string; billable: number; period_id: string | null; created_at: string; person_name?: string; pod_name?: string; block_type: string; decisions: string; }
export const BLOCK_TYPES = ["hours", "advisory", "sprint", "milestone"];
function validBlockType(v: unknown): string {
  const t = String(v || "hours").toLowerCase();
  if (!BLOCK_TYPES.includes(t)) throw Object.assign(new Error("block_type must be one of " + BLOCK_TYPES.join(", ")), { status: 400 });
  return t;
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validateTime(p: { person_id: string; pod_id: string; day: string; hours: number }) {
  const hours = Number(p.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24)
    throw Object.assign(new Error("hours must be > 0 and <= 24"), { status: 400 });
  if (!DAY_RE.test(p.day || "")) throw Object.assign(new Error("day must be YYYY-MM-DD"), { status: 400 });
  if (!getPerson(p.person_id)) throw Object.assign(new Error("person not found"), { status: 404 });
  if (!getPod(p.pod_id)) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!isMember(p.pod_id, p.person_id))
    throw Object.assign(new Error("person is not a member of this pod"), { status: 400 });
  return hours;
}
export const getEntry = (id: string) => (db.query("SELECT * FROM time_entries WHERE id = ?").get(id) as TimeEntry) || null;
export function entryLocked(id: string): boolean {
  const e = getEntry(id); if (!e || !e.period_id) return false;
  const per = getPeriod(e.period_id);
  return !!per && per.status === "closed";
}
export function listEntries(f: { person_id?: string; pod_id?: string; from?: string; to?: string; period_id?: string } = {}): TimeEntry[] {
  const wh: string[] = []; const args: any[] = [];
  if (f.person_id) { wh.push("t.person_id = ?"); args.push(f.person_id); }
  if (f.pod_id) { wh.push("t.pod_id = ?"); args.push(f.pod_id); }
  if (f.from) { wh.push("t.day >= ?"); args.push(f.from); }
  if (f.to) { wh.push("t.day <= ?"); args.push(f.to); }
  if (f.period_id) { wh.push("t.period_id = ?"); args.push(f.period_id); }
  return db.query(
    `SELECT t.*, p.name AS person_name, po.name AS pod_name FROM time_entries t
     LEFT JOIN people p ON p.id = t.person_id LEFT JOIN pods po ON po.id = t.pod_id
     ${wh.length ? "WHERE " + wh.join(" AND ") : ""} ORDER BY t.day, t.created_at`
  ).all(...args) as TimeEntry[];
}
export function createEntry(p: { person_id: string; pod_id: string; day: string; hours: number; note?: string; billable?: number; block_type?: string; decisions?: string }): TimeEntry {
  const hours = validateTime(p);
  const row = { id: uid(), person_id: p.person_id, pod_id: p.pod_id, day: p.day, hours, note: (p.note || "").trim(), billable: p.billable === 0 ? 0 : 1, period_id: null as string | null, created_at: nowIso(), block_type: validBlockType(p.block_type), decisions: String(p.decisions || "").trim().slice(0, 2000) };
  db.query("INSERT INTO time_entries (id, person_id, pod_id, day, hours, note, billable, period_id, created_at, block_type, decisions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.person_id, row.pod_id, row.day, row.hours, row.note, row.billable, row.period_id, row.created_at, row.block_type, row.decisions);
  return row as TimeEntry;
}
export function updateEntry(id: string, p: { day?: string; hours?: number; note?: string; billable?: number; pod_id?: string; block_type?: string; decisions?: string }): TimeEntry | null {
  const cur = getEntry(id); if (!cur) return null;
  if (entryLocked(id)) throw Object.assign(new Error("entry is in a closed pay period"), { status: 403 });
  const next = { person_id: cur.person_id, pod_id: p.pod_id || cur.pod_id, day: p.day || cur.day, hours: p.hours ?? cur.hours };
  const hours = validateTime(next);
  const block_type = p.block_type === undefined ? cur.block_type : validBlockType(p.block_type);
  const decisions = p.decisions === undefined ? cur.decisions : String(p.decisions || "").trim().slice(0, 2000);
  db.query("UPDATE time_entries SET pod_id = ?, day = ?, hours = ?, note = ?, billable = ?, block_type = ?, decisions = ? WHERE id = ?")
    .run(next.pod_id, next.day, hours, (p.note ?? cur.note).trim(), p.billable === undefined ? cur.billable : (p.billable ? 1 : 0), block_type, decisions, id);
  return getEntry(id);
}
export function deleteEntry(id: string): boolean {
  if (!getEntry(id)) return false;
  if (entryLocked(id)) throw Object.assign(new Error("entry is in a closed pay period"), { status: 403 });
  return db.query("DELETE FROM time_entries WHERE id = ?").run(id).changes > 0;
}

// ---------- pay periods ----------
export interface PayPeriod { id: string; label: string; start_day: string; end_day: string; status: string; closed_at: string | null; created_at: string; }
export const listPeriods = () => db.query("SELECT * FROM pay_periods ORDER BY start_day DESC").all() as PayPeriod[];
export const getPeriod = (id: string) => (db.query("SELECT * FROM pay_periods WHERE id = ?").get(id) as PayPeriod) || null;
export const openPeriod = () => (db.query("SELECT * FROM pay_periods WHERE status = 'open' LIMIT 1").get() as PayPeriod) || null;
export function createPeriod(p: { label: string; start_day: string; end_day: string }): PayPeriod {
  if (!p.label?.trim()) throw Object.assign(new Error("label is required"), { status: 400 });
  if (!DAY_RE.test(p.start_day || "") || !DAY_RE.test(p.end_day || "") || p.start_day > p.end_day)
    throw Object.assign(new Error("need a valid start_day <= end_day (YYYY-MM-DD)"), { status: 400 });
  if (openPeriod()) throw Object.assign(new Error("close the current open period first"), { status: 409 });
  const row: PayPeriod = { id: uid(), label: p.label.trim(), start_day: p.start_day, end_day: p.end_day, status: "open", closed_at: null, created_at: nowIso() };
  db.query("INSERT INTO pay_periods (id, label, start_day, end_day, status, closed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.label, row.start_day, row.end_day, row.status, row.closed_at, row.created_at);
  return row;
}
export interface PayStatement { id: string; period_id: string; person_id: string; pod_id: string; hours: number; rate_cents: number; amount_cents: number; created_at: string; person_name?: string; pod_name?: string; }
export function closePeriod(id: string): { period: PayPeriod; statements: PayStatement[] } {
  const per = getPeriod(id);
  if (!per) throw Object.assign(new Error("period not found"), { status: 404 });
  if (per.status !== "open") throw Object.assign(new Error("period is not open"), { status: 409 });
  // Stamp open entries in range, then snapshot statements grouped by person × pod.
  db.query("UPDATE time_entries SET period_id = ? WHERE period_id IS NULL AND day >= ? AND day <= ?")
    .run(id, per.start_day, per.end_day);
  const groups = db.query(
    `SELECT person_id, pod_id, SUM(hours) AS hours FROM time_entries
     WHERE period_id = ? GROUP BY person_id, pod_id`
  ).all(id) as { person_id: string; pod_id: string; hours: number }[];
  const statements: PayStatement[] = [];
  const ts = nowIso();
  for (const g of groups) {
    const person = getPerson(g.person_id); if (!person) continue;
    const rate = person.hourly_rate_cents;
    const amount = Math.round(g.hours * rate);
    const st: PayStatement = { id: uid(), period_id: id, person_id: g.person_id, pod_id: g.pod_id, hours: g.hours, rate_cents: rate, amount_cents: amount, created_at: ts };
    db.query("INSERT INTO pay_statements (id, period_id, person_id, pod_id, hours, rate_cents, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(st.id, st.period_id, st.person_id, st.pod_id, st.hours, st.rate_cents, st.amount_cents, st.created_at);
    statements.push(st);
  }
  db.query("UPDATE pay_periods SET status = 'closed', closed_at = ? WHERE id = ?").run(ts, id);
  return { period: getPeriod(id)!, statements };
}
export const listStatements = (periodId: string) =>
  db.query(
    `SELECT s.*, p.name AS person_name, po.name AS pod_name FROM pay_statements s
     LEFT JOIN people p ON p.id = s.person_id LEFT JOIN pods po ON po.id = s.pod_id
     WHERE s.period_id = ? ORDER BY person_name, pod_name`
  ).all(periodId) as PayStatement[];

/** Live (unstamped) totals for an open period — what closing *would* snapshot. */
export function periodLiveTotals(periodId: string) {
  const per = getPeriod(periodId);
  if (!per) return [];
  return db.query(
    `SELECT t.person_id, p.name AS person_name, t.pod_id, po.name AS pod_name,
            SUM(t.hours) AS hours, p.hourly_rate_cents AS rate_cents,
            CAST(ROUND(SUM(t.hours) * p.hourly_rate_cents) AS INTEGER) AS amount_cents
     FROM time_entries t
     JOIN people p ON p.id = t.person_id LEFT JOIN pods po ON po.id = t.pod_id
     WHERE t.period_id IS NULL AND t.day >= ? AND t.day <= ?
     GROUP BY t.person_id, t.pod_id ORDER BY person_name, pod_name`
  ).all(per.start_day, per.end_day);
}

export function statementsCsv(periodId: string): string {
  const per = getPeriod(periodId);
  const rows = per && per.status === "open" ? periodLiveTotals(periodId) : listStatements(periodId);
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return ["person,pod,hours,rate_cents,amount_cents",
    ...rows.map((r: any) => [r.person_name || r.person_id, r.pod_name || r.pod_id, r.hours, r.rate_cents, r.amount_cents].map(esc).join(",")),
  ].join("\n") + "\n";
}

// ---------- dashboard ----------
export function weekRange(dayIso?: string): { from: string; to: string } {  const d = dayIso && DAY_RE.test(dayIso) ? new Date(dayIso + "T12:00:00Z") : new Date();
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { from: f(mon), to: f(sun) };
}
export function dashboard() {
  const { from, to } = weekRange();
  const perPod = db.query(
    `SELECT t.pod_id, po.name AS pod_name, po.color, SUM(t.hours) AS hours, COUNT(*) AS entries
     FROM time_entries t JOIN pods po ON po.id = t.pod_id
     WHERE t.day >= ? AND t.day <= ? GROUP BY t.pod_id ORDER BY hours DESC`
  ).all(from, to);
  const per = openPeriod();
  const perPerson = per
    ? db.query(
        `SELECT t.person_id, p.name AS person_name, SUM(t.hours) AS hours
         FROM time_entries t JOIN people p ON p.id = t.person_id
         WHERE t.day >= ? AND t.day <= ? GROUP BY t.person_id ORDER BY hours DESC`
      ).all(per.start_day, per.end_day)
    : [];
  const retainers = listPods()
    .filter((p) => p.billing_type === "retainer" && p.retainer_hours)
    .map((p) => ({ pod_id: p.id, pod_name: p.name, color: p.color, ...retainerUsage(p.id)! }));
  return { week: { from, to }, hoursPerPod: perPod, openPeriod: per, openPeriodPerPerson: perPerson, retainers, timers: activeTimers() };
}

// ---------- seed ----------
const hasRows = (t: string) => ((db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number) > 0;
export function seed() {
  if (hasRows("pods")) return; // already seeded
  const P = (name: string, email: string, title: string, rate: number) =>
    createPerson({ name, email, title, hourly_rate_cents: rate });
  const marcus = P("Marcus Bell", "marcus@fractional.co", "Fractional COO", 22500);
  const acme = [
    P("Ava Reyes", "ava@fractional.co", "Fractional CEO", 27500),
    marcus,
    P("Priya Shah", "priya@fractional.co", "Fractional CFO", 25000),
    P("Jonah Lee", "jonah@fractional.co", "Fractional CMO", 20000),
  ];
  const bright = [
    P("Sofia Marino", "sofia@fractional.co", "Fractional CEO", 27500),
    marcus, // serves both pods
    P("Elena Petrova", "elena@fractional.co", "Fractional CTO", 24000),
  ];
  const mk = (name: string, client: string, color: string, team: { p: Person; role: string }[]) => {
    const pod = createPod({ name, client_name: client, color });
    for (const m of team) addMember(pod.id, m.p.id, m.role);
    return pod;
  };
  const acmePod = mk("Acme Foods", "Acme Foods Inc", "#c96f4a",
    [{ p: acme[0], role: "Lead" }, { p: acme[1], role: "Ops" }, { p: acme[2], role: "Finance" }, { p: acme[3], role: "Growth" }]);
  const brightPod = mk("Brightline", "Brightline SaaS", "#5f7a6a",
    [{ p: bright[0], role: "Lead" }, { p: bright[1], role: "Ops" }, { p: bright[2], role: "Tech" }]);

  const msg = (pod: Pod, ch: string, author: Person, body: string, parent: string | null = null) => {
    const c = listChannels(pod.id).find((x) => x.name === ch)!;
    return createMessage({ pod_id: pod.id, channel_id: c.id, author_id: author.id, body_md: body, thread_parent_id: parent });
  };
  for (const pod of [acmePod, brightPod]) {
    createChannel(pod.id, "wins");
    createChannel(pod.id, "finance");
  }
  const a1 = msg(acmePod, "general", acme[0], "Morning, pod. Q4 planning kicks off this week — **priorities doc** is on the wiki.");
  msg(acmePod, "general", acme[1], "Ops review moved to Thursday. Supply chain finally stable.", a1.id);
  msg(acmePod, "general", acme[2], "Board deck draft is up in #finance. Feedback by EOD?", a1.id);
  msg(acmePod, "wins", acme[3], "We just closed the regional distributor — *big* quarter ahead.");
  msg(acmePod, "finance", acme[2], "Burn is down 12% MoM. Runway now 22 months.");
  const b1 = msg(brightPod, "general", bright[0], "Welcome to the Brightline pod. First client sync is Monday 10am.");
  msg(brightPod, "general", bright[2], "Staging env is green. I'll demo the new onboarding flow.", b1.id);
  msg(brightPod, "wins", bright[1], "Churn dropped under 3% — the onboarding work is paying off.");

  const page = (pod: Pod, title: string, body: string, by: Person) =>
    createPage(pod.id, { title, body_md: body, updated_by: by.name });
  page(acmePod, "Q4 Priorities", "# Q4 Priorities\n\n1. Launch regional distribution\n2. Cut burn below $180k/mo\n3. Hire full-time ops lead by December\n\nOwner: Ava", acme[0]);
  page(acmePod, "Board Deck — Oct", "# October Board Deck\n\n- Revenue: $412k MRR\n- Burn: $196k\n- Headcount plan attached in #finance", acme[2]);
  page(acmePod, "Brand Voice", "# Brand Voice\n\nPlainspoken, warm, never hype-y. We sell groceries, not dreams.", acme[3]);
  page(brightPod, "Client Overview", "# Brightline SaaS\n\nB2B onboarding platform. 140 customers, $88k MRR.\n\nKey contacts: Dana (CEO), Raj (Head of Product).", bright[0]);
  page(brightPod, "Tech Notes", "# Tech Notes\n\n- Stack: Postgres + Bun\n- Staging: https://staging.brightline.example\n- Oncall: Elena", bright[2]);

  const { from } = weekRange();
  const days = [0, 1, 2, 3].map((i) => { const d = new Date(from + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const t = (p: Person, pod: Pod, day: string, h: number, note: string, billable = 1) =>
    createEntry({ person_id: p.id, pod_id: pod.id, day, hours: h, note, billable });
  t(acme[0], acmePod, days[0], 4, "Q4 planning session");
  t(acme[0], acmePod, days[1], 3.5, "Board prep");
  t(acme[1], acmePod, days[0], 5, "Ops review + supply chain");
  t(acme[1], brightPod, days[1], 2, "Brightline onboarding sync", 1);
  t(acme[2], acmePod, days[2], 6, "Board deck + burn analysis");
  t(acme[3], acmePod, days[1], 4, "Distributor launch assets");
  t(bright[0], brightPod, days[0], 3, "Client kickoff");
  t(bright[2], brightPod, days[2], 7.5, "Onboarding flow build");
  t(bright[2], brightPod, days[3], 4, "Staging deploy", 0);

  const sun = new Date(from + "T12:00:00Z"); sun.setUTCDate(sun.getUTCDate() + 6);
  createPeriod({ label: "Week of " + from, start_day: from, end_day: sun.toISOString().slice(0, 10) });

  // Phase 2: example objectives so the Objectives tab opens with a story
  const q = new Date().getFullYear() + "-Q" + (Math.floor(new Date().getMonth() / 3) + 1);
  const o1 = createObjective(acmePod.id, { title: "Cut monthly burn below $180k", period: q, progress_pct: 60, status: "on_track" });
  createKeyResult(o1.id, { title: "Renegotiate distributor terms", target: "−$25k/mo", current: "−$14k/mo" });
  createKeyResult(o1.id, { title: "Ops headcount plan signed off", target: "1 hire", current: "shortlist of 3" });
  const o2 = createObjective(brightPod.id, { title: "Ship self-serve onboarding", period: q, progress_pct: 35, status: "at_risk" });
  createKeyResult(o2.id, { title: "Activation rate", target: "40%", current: "28%" });
  console.log("seeded Podium: 2 pods, 7 people, channels, messages, pages, time entries, 1 open period, 2 objectives");
}

// ---------- settings (secrets stay server-side; GET masks them) ----------
const SECRET_KEYS = new Set([
  "stripe_test_secret", "stripe_live_secret", "stripe_webhook_secret",
  "slack_bot_token", "qbo_client_secret", "qbo_refresh_token",
  "clickup_token", "imap_pass",
]);
export const KNOWN_SETTINGS = [
  "stripe_mode", "stripe_test_publishable", "stripe_test_secret",
  "stripe_live_publishable", "stripe_live_secret", "stripe_webhook_secret",
  "slack_bot_token",
  "qbo_client_id", "qbo_client_secret", "qbo_redirect_uri", "qbo_sandbox",
  "qbo_realm_id", "qbo_refresh_token",
  "clickup_token",
  "imap_host", "imap_port", "imap_user", "imap_pass",
  "platform_spread_pct", "payouts_live",
];
export function getSetting(key: string): string {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r ? r.value : "";
}
export function setSetting(key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, String(value ?? ""), nowIso());
}
/** Masked view for the client: secrets come back as {set, preview} only. */
export function publicSettings(): Record<string, { set: boolean; preview: string }> {
  const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, { set: boolean; preview: string }> = {};
  for (const k of KNOWN_SETTINGS) {
    const v = map.get(k) || "";
    out[k] = SECRET_KEYS.has(k)
      ? { set: !!v, preview: v ? "••••" + v.slice(-4) : "" }
      : { set: !!v, preview: k === "stripe_mode" && !v ? "test" : v };
  }
  return out;
}
/** The Stripe secret for the currently selected mode. Empty = not connected. */
export function activeStripeSecret(): string {
  const mode = getSetting("stripe_mode") || "test";
  return mode === "live" ? getSetting("stripe_live_secret") : getSetting("stripe_test_secret");
}
export function stripeMode(): string {
  return getSetting("stripe_mode") || "test";
}

// ---------- CRM: partners ----------
const PARTNER_KINDS = ["vc", "accelerator", "other"];
export interface Partner { id: string; name: string; kind: string; contact_name: string; contact_email: string; notes: string; created_at: string; }
export const listPartners = () => db.query("SELECT * FROM partners ORDER BY name COLLATE NOCASE").all() as Partner[];
export const getPartner = (id: string) => (db.query("SELECT * FROM partners WHERE id = ?").get(id) as Partner) || null;
export function createPartner(p: { name: string; kind?: string; contact_name?: string; contact_email?: string; notes?: string }): Partner {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const kind = (p.kind || "other").toLowerCase();
  if (!PARTNER_KINDS.includes(kind)) throw Object.assign(new Error("kind must be vc, accelerator, or other"), { status: 400 });
  const row: Partner = {
    id: uid(), name: p.name.trim(), kind,
    contact_name: (p.contact_name || "").trim(), contact_email: (p.contact_email || "").trim(),
    notes: (p.notes || "").trim(), created_at: nowIso(),
  };
  db.query("INSERT INTO partners (id, name, kind, contact_name, contact_email, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.kind, row.contact_name, row.contact_email, row.notes, row.created_at);
  return row;
}
export function updatePartner(id: string, p: Partial<Partner>): Partner | null {
  const cur = getPartner(id); if (!cur) return null;
  const kind = (p.kind ?? cur.kind).toLowerCase();
  if (!PARTNER_KINDS.includes(kind)) throw Object.assign(new Error("kind must be vc, accelerator, or other"), { status: 400 });
  const row = {
    name: (p.name ?? cur.name).trim() || cur.name, kind,
    contact_name: (p.contact_name ?? cur.contact_name).trim(),
    contact_email: (p.contact_email ?? cur.contact_email).trim(),
    notes: (p.notes ?? cur.notes).trim(),
  };
  db.query("UPDATE partners SET name = ?, kind = ?, contact_name = ?, contact_email = ?, notes = ? WHERE id = ?")
    .run(row.name, row.kind, row.contact_name, row.contact_email, row.notes, id);
  return getPartner(id);
}
export function deletePartner(id: string): boolean {
  db.query("UPDATE leads SET partner_id = NULL WHERE partner_id = ?").run(id);
  return db.query("DELETE FROM partners WHERE id = ?").run(id).changes > 0;
}

// ---------- CRM: leads ----------
export const LEAD_STAGES = ["intro", "diagnostic", "sow", "won", "lost"];
export const STAGE_LABEL: Record<string, string> = {
  intro: "Intro Call", diagnostic: "Diagnostic Pitch", sow: "SOW Sent", won: "Closed Won", lost: "Lost",
};
export const STAGE_PROB: Record<string, number> = { intro: 0.1, diagnostic: 0.3, sow: 0.6, won: 1, lost: 0 };
const LEAD_TEMPS = ["hot", "warm", "cold"];
export interface Lead {
  id: string; name: string; company: string; email: string; phone: string; source: string;
  temperature: string; priority: number; value_cents: number; stage: string; notes: string;
  partner_id: string | null; booking_id: string | null; pod_id: string | null; created_at: string;
  partner_name?: string; pod_name?: string;
  budget_band: string; contact_method: string;
}
export const BUDGET_BANDS = ["<$5k/mo", "$5–10k/mo", "$10k+/mo"];
function validBudgetBand(v: unknown): string {
  const t = String(v || "").trim();
  if (!t) return "";
  if (!BUDGET_BANDS.includes(t)) throw Object.assign(new Error("budget_band must be one of " + BUDGET_BANDS.join(", ")), { status: 400 });
  return t;
}
function leadWithJoins(where: string, ...args: any[]): Lead[] {
  return db.query(
    `SELECT l.*, pt.name AS partner_name, po.name AS pod_name FROM leads l
     LEFT JOIN partners pt ON pt.id = l.partner_id LEFT JOIN pods po ON po.id = l.pod_id
     ${where} ORDER BY l.created_at DESC`
  ).all(...args) as Lead[];
}
export const listLeads = (f: { stage?: string; temperature?: string } = {}) => {
  const wh: string[] = []; const args: any[] = [];
  if (f.stage) { wh.push("l.stage = ?"); args.push(f.stage); }
  if (f.temperature) { wh.push("l.temperature = ?"); args.push(f.temperature); }
  return leadWithJoins(wh.length ? "WHERE " + wh.join(" AND ") : "", ...args);
};
export const getLead = (id: string) => leadWithJoins("WHERE l.id = ?", id)[0] || null;
/** Warm + hot leads, priority then value — the firm's Top 20. */
export function topLeads(limit = 20): Lead[] {
  return leadWithJoins("WHERE l.temperature IN ('hot','warm') AND l.stage NOT IN ('won','lost')", )
    .sort((a, b) => a.priority - b.priority || b.value_cents - a.value_cents)
    .slice(0, limit);
}
export function createLead(p: Partial<Lead> & { name: string }): Lead {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const temperature = (p.temperature || "warm").toLowerCase();
  if (!LEAD_TEMPS.includes(temperature)) throw Object.assign(new Error("temperature must be hot, warm, or cold"), { status: 400 });
  const priority = Math.min(5, Math.max(1, Math.round(Number(p.priority) || 3)));
  const value_cents = Math.max(0, Math.round(Number(p.value_cents) || 0));
  const stage = (p.stage || "intro").toLowerCase();
  if (!LEAD_STAGES.includes(stage)) throw Object.assign(new Error("unknown stage"), { status: 400 });
  if (p.partner_id && !getPartner(p.partner_id)) throw Object.assign(new Error("partner not found"), { status: 404 });
  const row = {
    id: uid(), name: p.name.trim(), company: (p.company || "").trim(),
    email: (p.email || "").trim(), phone: (p.phone || "").trim(), source: (p.source || "").trim(),
    temperature, priority, value_cents, stage, notes: (p.notes || "").trim(),
    partner_id: p.partner_id || null, booking_id: p.booking_id || null, pod_id: null as string | null,
    created_at: nowIso(),
    budget_band: validBudgetBand(p.budget_band), contact_method: String(p.contact_method || "").trim().slice(0, 40),
  };
  db.query(`INSERT INTO leads (id, name, company, email, phone, source, temperature, priority, value_cents, stage, notes, partner_id, booking_id, pod_id, created_at, budget_band, contact_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.name, row.company, row.email, row.phone, row.source, row.temperature, row.priority,
      row.value_cents, row.stage, row.notes, row.partner_id, row.booking_id, row.pod_id, row.created_at,
      row.budget_band, row.contact_method);
  return getLead(row.id)!;
}
export function updateLead(id: string, p: Partial<Lead>): Lead | null {
  const cur = getLead(id); if (!cur) return null;
  const temperature = (p.temperature ?? cur.temperature).toLowerCase();
  if (!LEAD_TEMPS.includes(temperature)) throw Object.assign(new Error("temperature must be hot, warm, or cold"), { status: 400 });
  const priority = p.priority == null ? cur.priority : Math.min(5, Math.max(1, Math.round(Number(p.priority) || 3)));
  const value_cents = p.value_cents == null ? cur.value_cents : Math.max(0, Math.round(Number(p.value_cents) || 0));
  const partner_id = p.partner_id === undefined ? cur.partner_id : (p.partner_id || null);
  if (partner_id && !getPartner(partner_id)) throw Object.assign(new Error("partner not found"), { status: 404 });
  const booking_id = p.booking_id === undefined ? cur.booking_id : (p.booking_id || null);
  const row = {
    name: (p.name ?? cur.name).trim() || cur.name, company: (p.company ?? cur.company).trim(),
    email: (p.email ?? cur.email).trim(), phone: (p.phone ?? cur.phone).trim(),
    source: (p.source ?? cur.source).trim(), temperature, priority, value_cents,
    notes: (p.notes ?? cur.notes).trim(), partner_id, booking_id,
  };
  db.query(`UPDATE leads SET name = ?, company = ?, email = ?, phone = ?, source = ?, temperature = ?, priority = ?, value_cents = ?, notes = ?, partner_id = ?, booking_id = ? WHERE id = ?`)
    .run(row.name, row.company, row.email, row.phone, row.source, row.temperature, row.priority,
      row.value_cents, row.notes, row.partner_id, row.booking_id, id);
  return getLead(id);
}
/**
 * Stage machine: forward exactly one step, or to `lost` from anywhere.
 * `won` and `lost` are terminal. Judgment call, documented in README.
 */
export function canMoveLead(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === "won" || from === "lost") return false;
  if (to === "lost") return true;
  const order = ["intro", "diagnostic", "sow", "won"];
  return order.indexOf(to) === order.indexOf(from) + 1;
}
export function moveLead(id: string, to: string): Lead {
  const cur = getLead(id);
  if (!cur) throw Object.assign(new Error("lead not found"), { status: 404 });
  const stage = (to || "").toLowerCase();
  if (!LEAD_STAGES.includes(stage)) throw Object.assign(new Error("unknown stage"), { status: 400 });
  if (!canMoveLead(cur.stage, stage))
    throw Object.assign(new Error(`cannot move from ${STAGE_LABEL[cur.stage]} to ${STAGE_LABEL[stage]}`), { status: 409 });
  db.query("UPDATE leads SET stage = ? WHERE id = ?").run(stage, id);
  return getLead(id)!;
}
/** The money loop: a won deal becomes a pod. */
export function spinUpPod(leadId: string): { lead: Lead; pod: Pod } {
  const lead = getLead(leadId);
  if (!lead) throw Object.assign(new Error("lead not found"), { status: 404 });
  if (lead.stage !== "won") throw Object.assign(new Error("only Closed Won deals can spin up a pod"), { status: 409 });
  if (lead.pod_id) throw Object.assign(new Error("this deal already has a pod"), { status: 409 });
  const pod = createPod({ name: lead.company || lead.name, client_name: lead.company || lead.name });
  db.query("UPDATE leads SET pod_id = ? WHERE id = ?").run(pod.id, leadId);
  return { lead: getLead(leadId)!, pod };
}
export function deleteLead(id: string): boolean {
  return db.query("DELETE FROM leads WHERE id = ?").run(id).changes > 0;
}
export interface PipelineStage { stage: string; label: string; count: number; total_cents: number; weighted_cents: number; leads: Lead[]; }
export function pipelineSummary(): PipelineStage[] {
  const leads = listLeads();
  return LEAD_STAGES.map((stage) => {
    const ls = leads.filter((l) => l.stage === stage);
    const total_cents = ls.reduce((a, l) => a + l.value_cents, 0);
    return {
      stage, label: STAGE_LABEL[stage], count: ls.length, total_cents,
      weighted_cents: Math.round(total_cents * STAGE_PROB[stage]), leads: ls,
    };
  });
}

// ---------- templates & knowledge base ----------
export interface Template { id: string; name: string; kind: string; body_md: string; created_at: string; }
export const listTemplates = () => db.query("SELECT * FROM templates ORDER BY name COLLATE NOCASE").all() as Template[];
export const getTemplate = (id: string) => (db.query("SELECT * FROM templates WHERE id = ?").get(id) as Template) || null;
export function createTemplate(p: { name: string; kind?: string; body_md?: string }): Template {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const row: Template = { id: uid(), name: p.name.trim(), kind: (p.kind || "doc").trim(), body_md: p.body_md || "", created_at: nowIso() };
  db.query("INSERT INTO templates (id, name, kind, body_md, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.kind, row.body_md, row.created_at);
  return row;
}
export function updateTemplate(id: string, p: Partial<Template>): Template | null {
  const cur = getTemplate(id); if (!cur) return null;
  const row = { name: (p.name ?? cur.name).trim() || cur.name, kind: (p.kind ?? cur.kind).trim(), body_md: p.body_md ?? cur.body_md };
  db.query("UPDATE templates SET name = ?, kind = ?, body_md = ? WHERE id = ?").run(row.name, row.kind, row.body_md, id);
  return getTemplate(id);
}
export function deleteTemplate(id: string): boolean {
  return db.query("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
}
/** Substitute {{variable}} placeholders. Unknown variables become "". */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return String(body || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}
export function pageFromTemplate(podId: string, templateId: string, vars: Record<string, string>, title?: string): Page {
  const t = getTemplate(templateId);
  if (!t) throw Object.assign(new Error("template not found"), { status: 404 });
  return createPage(podId, {
    title: (title || t.name).trim(),
    body_md: renderTemplate(t.body_md, vars),
    updated_by: vars.owner_name || "",
  });
}
const TEMPLATE_SEED: { name: string; kind: string; body_md: string }[] = [
  {
    name: "Statement of Work", kind: "sow",
    body_md: `# Statement of Work — {{client_name}}

**Pod:** {{pod_name}}
**Date:** {{date}}
**Prepared by:** {{owner_name}}

## Objectives
- Objective 1: what success looks like
- Objective 2: measurable outcome

## Scope
- In scope: ...
- Out of scope: ...

## Term & commercial
- Monthly retainer hours: ...
- Rate: ...
- Term: ... months, auto-renewing

## Out of scope
Anything not listed above requires a change order.

---
*Signed:* ______________________  *Date:* __________`,
  },
  {
    name: "Meeting Notes", kind: "notes",
    body_md: `# Meeting Notes — {{client_name}}

**Date:** {{date}}
**Pod:** {{pod_name}}
**Attendees:** {{owner_name}}, ...

## Decisions
- ...

## Action items
- [ ] Owner — task — due date

## Next meeting
...`,
  },
  {
    name: "30-60-90 Day Roadmap", kind: "roadmap",
    body_md: `# 30-60-90 Day Roadmap — {{client_name}}

**Pod:** {{pod_name}} · **Kickoff:** {{date}} · **Owner:** {{owner_name}}

## First 30 days — Learn
- Goal: ...
- Deliverable: ...

## Days 31–60 — Build
- Goal: ...
- Deliverable: ...

## Days 61–90 — Scale
- Goal: ...
- Deliverable: ...`,
  },
  {
    name: "Deliverables Tracker", kind: "tracker",
    body_md: `# Deliverables Tracker — {{client_name}}

**Pod:** {{pod_name}} · **Updated:** {{date}}

| Deliverable | Owner | Due | Status |
|---|---|---|---|
| ... | {{owner_name}} | ... | Not started |

*Status values: Not started · In progress · Blocked · Done*`,
  },
];
export function seedTemplates() {
  if ((db.query("SELECT COUNT(*) AS n FROM templates").get() as any).n > 0) return;
  for (const t of TEMPLATE_SEED) createTemplate(t);
}

// ---------- timers: the big green button ----------
export interface Timer { id: string; person_id: string; pod_id: string; note: string; started_at: string; person_name?: string; pod_name?: string; }
export const activeTimerFor = (personId: string) =>
  (db.query("SELECT * FROM timers WHERE person_id = ? LIMIT 1").get(personId) as Timer) || null;
export function activeTimers(): Timer[] {
  return db.query(
    `SELECT t.*, p.name AS person_name, po.name AS pod_name FROM timers t
     LEFT JOIN people p ON p.id = t.person_id LEFT JOIN pods po ON po.id = t.pod_id
     ORDER BY t.started_at`
  ).all() as Timer[];
}
export function startTimer(p: { person_id: string; pod_id: string; note?: string }): Timer {
  if (!getPerson(p.person_id)) throw Object.assign(new Error("person not found"), { status: 404 });
  if (!getPod(p.pod_id)) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!isMember(p.pod_id, p.person_id))
    throw Object.assign(new Error("person is not a member of this pod"), { status: 400 });
  if (activeTimerFor(p.person_id))
    throw Object.assign(new Error("a timer is already running for this person"), { status: 409 });
  const row: Timer = { id: uid(), person_id: p.person_id, pod_id: p.pod_id, note: (p.note || "").trim(), started_at: nowIso() };
  db.query("INSERT INTO timers (id, person_id, pod_id, note, started_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.person_id, row.pod_id, row.note, row.started_at);
  return row;
}
/** Billing increments: round UP to the nearest tenth of an hour, minimum 0.1h. */
export function billableHours(elapsedSec: number): number {
  return Math.max(0.1, Math.ceil((Math.max(0, elapsedSec) / 3600) * 10) / 10);
}
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function stopTimer(personId: string, opts?: { block_type?: string; decisions?: string }): { timer: Timer; entry: TimeEntry; hours: number; elapsed_sec: number } {
  const t = activeTimerFor(personId);
  if (!t) throw Object.assign(new Error("no active timer for this person"), { status: 404 });
  const elapsed_sec = Math.max(0, (Date.now() - new Date(t.started_at).getTime()) / 1000);
  const hours = billableHours(elapsed_sec);
  if (hours > 24) throw Object.assign(new Error("timer ran over 24h — log it manually"), { status: 400 });
  const entry = createEntry({ person_id: t.person_id, pod_id: t.pod_id, day: localDay(new Date()), hours, note: t.note || "Timer", block_type: opts?.block_type, decisions: opts?.decisions });
  db.query("DELETE FROM timers WHERE id = ?").run(t.id);
  return { timer: t, entry, hours, elapsed_sec: Math.round(elapsed_sec) };
}

// ---------- retainers ----------
export function updatePodBilling(id: string, p: { billing_type?: string; retainer_hours?: number | null; retainer_rate_cents?: number }): Pod | null {
  const cur = getPod(id); if (!cur) return null;
  const billing_type = (p.billing_type ?? cur.billing_type).toLowerCase();
  if (!["retainer", "hourly"].includes(billing_type))
    throw Object.assign(new Error("billing_type must be retainer or hourly"), { status: 400 });
  const retainer_hours = p.retainer_hours === undefined ? cur.retainer_hours
    : (p.retainer_hours == null || p.retainer_hours === 0 ? null : Math.max(0, Number(p.retainer_hours) || 0) || null);
  const retainer_rate_cents = p.retainer_rate_cents == null ? cur.retainer_rate_cents : Math.max(0, Math.round(Number(p.retainer_rate_cents) || 0));
  db.query("UPDATE pods SET billing_type = ?, retainer_hours = ?, retainer_rate_cents = ? WHERE id = ?")
    .run(billing_type, retainer_hours, retainer_rate_cents, id);
  return getPod(id);
}
/** Month-to-date billable hours vs the retainer cap. */
export function retainerUsage(podId: string): { hours: number; cap: number; pct: number } | null {
  const pod = getPod(podId);
  if (!pod || pod.billing_type !== "retainer" || !pod.retainer_hours) return null;
  const d = new Date();
  const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const today = localDay(d);
  const r = db.query(
    "SELECT COALESCE(SUM(hours), 0) AS h FROM time_entries WHERE pod_id = ? AND billable = 1 AND day >= ? AND day <= ?"
  ).get(podId, monthStart, today) as { h: number };
  const hours = Math.round(r.h * 100) / 100;
  return { hours, cap: pod.retainer_hours, pct: pod.retainer_hours > 0 ? hours / pod.retainer_hours : 0 };
}

// ---------- scheduling: availability & bookings ----------
export interface Availability { id: string; person_id: string; weekday: number; start_min: number; end_min: number; }
export function listAvailability(personId: string): Availability[] {
  return db.query("SELECT * FROM availability WHERE person_id = ? ORDER BY weekday, start_min").all(personId) as Availability[];
}
export function setAvailability(p: { person_id: string; weekday: number; start_min: number; end_min: number }): Availability {
  if (!getPerson(p.person_id)) throw Object.assign(new Error("person not found"), { status: 404 });
  const weekday = Number(p.weekday);
  const start_min = Number(p.start_min), end_min = Number(p.end_min);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    throw Object.assign(new Error("weekday must be 0-6"), { status: 400 });
  if (!Number.isFinite(start_min) || !Number.isFinite(end_min) || start_min < 0 || end_min > 1440 || start_min >= end_min)
    throw Object.assign(new Error("need 0 <= start_min < end_min <= 1440"), { status: 400 });
  const row: Availability = { id: uid(), person_id: p.person_id, weekday, start_min: Math.floor(start_min), end_min: Math.floor(end_min) };
  db.query("INSERT INTO availability (id, person_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.person_id, row.weekday, row.start_min, row.end_min);
  return row;
}
export function deleteAvailability(id: string): boolean {
  return db.query("DELETE FROM availability WHERE id = ?").run(id).changes > 0;
}
/** Public booking slug for a person — generated on demand, unique. */
export function enableBookingSlug(personId: string): string {
  const person = getPerson(personId);
  if (!person) throw Object.assign(new Error("person not found"), { status: 404 });
  if (person.booking_slug) return person.booking_slug;
  const base = person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exec";
  let slug = base, i = 2;
  while ((db.query("SELECT 1 FROM people WHERE booking_slug = ?").get(slug))) slug = `${base}-${i++}`;
  db.query("UPDATE people SET booking_slug = ? WHERE id = ?").run(slug, personId);
  return slug;
}
export const getPersonBySlug = (slug: string) => {
  const r = db.query("SELECT * FROM people WHERE booking_slug = ?").get(slug) as any;
  return r ? personRow(r) : null;
};

export interface Booking {
  id: string; person_id: string; lead_id: string | null; start_at: string; end_at: string;
  status: string; booker_name: string; booker_email: string; notes: string; created_at: string;
  person_name?: string; lead_company?: string;
}
function bookingsWithJoins(where: string, ...args: any[]): Booking[] {
  return db.query(
    `SELECT b.*, p.name AS person_name, l.company AS lead_company FROM bookings b
     LEFT JOIN people p ON p.id = b.person_id LEFT JOIN leads l ON l.id = b.lead_id
     ${where} ORDER BY b.start_at`
  ).all(...args) as Booking[];
}
export const listBookings = (f: { person_id?: string; from?: string } = {}) => {
  const wh = ["b.status = 'confirmed'"]; const args: any[] = [];
  if (f.person_id) { wh.push("b.person_id = ?"); args.push(f.person_id); }
  if (f.from) { wh.push("b.start_at >= ?"); args.push(f.from); }
  return bookingsWithJoins("WHERE " + wh.join(" AND "), ...args);
};
export const getBooking = (id: string) => bookingsWithJoins("WHERE b.id = ?", id)[0] || null;
const SLOT_MIN = 30;
function overlaps(personId: string, start_at: string, end_at: string, excludeId?: string): boolean {
  const rows = db.query(
    `SELECT 1 FROM bookings WHERE person_id = ? AND status = 'confirmed'
     AND start_at < ? AND end_at > ? ${excludeId ? "AND id != ?" : ""} LIMIT 1`
  ).all(personId, end_at, start_at, ...(excludeId ? [excludeId] : []));
  return rows.length > 0;
}
function isoLocal(d: Date): string {
  return `${localDay(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}
/** Parse a "YYYY-MM-DDTHH:mm:ss" string as local time (no TZ shift). */
function parseNaive(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || "");
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
}
/** Next N days of free 30-min slots for a public booking page. */
export function freeSlots(slug: string, days = 14): { person: Person; slots: { start_at: string; end_at: string }[] } {
  const person = getPersonBySlug(slug);
  if (!person) throw Object.assign(new Error("booking page not found"), { status: 404 });
  const avail = listAvailability(person.id);
  const booked = listBookings({ person_id: person.id });
  const slots: { start_at: string; end_at: string }[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const day = new Date(now); day.setDate(day.getDate() + d); day.setHours(0, 0, 0, 0);
    const wd = day.getDay();
    for (const a of avail.filter((x) => x.weekday === wd)) {
      for (let m = a.start_min; m + SLOT_MIN <= a.end_min; m += SLOT_MIN) {
        const s = new Date(day); s.setHours(0, m, 0, 0);
        const e = new Date(s); e.setMinutes(e.getMinutes() + SLOT_MIN);
        if (s <= now) continue; // no past slots
        const start_at = isoLocal(s), end_at = isoLocal(e);
        if (booked.some((b) => b.start_at < end_at && b.end_at > start_at)) continue;
        slots.push({ start_at, end_at });
      }
    }
  }
  return { person, slots };
}
export function createBooking(p: {
  person_id: string; start_at: string; end_at: string; booker_name: string;
  booker_email?: string; notes?: string; lead_id?: string | null;
}): Booking {
  if (!getPerson(p.person_id)) throw Object.assign(new Error("person not found"), { status: 404 });
  if (!p.booker_name?.trim()) throw Object.assign(new Error("booker name is required"), { status: 400 });
  if (!p.start_at || !p.end_at || p.start_at >= p.end_at)
    throw Object.assign(new Error("need start_at < end_at"), { status: 400 });
  if (parseNaive(p.start_at).getTime() <= Date.now())
    throw Object.assign(new Error("cannot book in the past"), { status: 400 });
  if (overlaps(p.person_id, p.start_at, p.end_at))
    throw Object.assign(new Error("that slot is already booked"), { status: 409 });
  const lead_id = p.lead_id || null;
  if (lead_id && !getLead(lead_id)) throw Object.assign(new Error("lead not found"), { status: 404 });
  const row = {
    id: uid(), person_id: p.person_id, lead_id, start_at: p.start_at, end_at: p.end_at, status: "confirmed",
    booker_name: p.booker_name.trim(), booker_email: (p.booker_email || "").trim(),
    notes: (p.notes || "").trim(), created_at: nowIso(),
  };
  db.query(`INSERT INTO bookings (id, person_id, lead_id, start_at, end_at, status, booker_name, booker_email, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.person_id, row.lead_id, row.start_at, row.end_at, row.status, row.booker_name, row.booker_email, row.notes, row.created_at);
  if (lead_id) db.query("UPDATE leads SET booking_id = ? WHERE id = ?").run(row.id, lead_id);
  return getBooking(row.id)!;
}
/** Public booking: the slot must sit inside declared availability. */
export function publicBook(slug: string, p: { start_at: string; end_at: string; booker_name: string; booker_email?: string; notes?: string }): Booking {
  const person = getPersonBySlug(slug);
  if (!person) throw Object.assign(new Error("booking page not found"), { status: 404 });
  const s = parseNaive(p.start_at), e = parseNaive(p.end_at);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()))
    throw Object.assign(new Error("bad date format"), { status: 400 });
  if (e.getTime() - s.getTime() !== SLOT_MIN * 60 * 1000)
    throw Object.assign(new Error("bookings are 30 minutes"), { status: 400 });
  const mins = s.getHours() * 60 + s.getMinutes();
  const ok = listAvailability(person.id).some(
    (a) => a.weekday === s.getDay() && mins >= a.start_min && mins + SLOT_MIN <= a.end_min
  );
  if (!ok) throw Object.assign(new Error("that slot is outside availability"), { status: 400 });
  return createBooking({ person_id: person.id, ...p });
}
export function cancelBooking(id: string): Booking | null {
  const b = getBooking(id); if (!b) return null;
  db.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
  return getBooking(id);
}
export function linkBookingLead(bookingId: string, leadId: string | null): Booking | null {
  const b = getBooking(bookingId); if (!b) return null;
  if (leadId && !getLead(leadId)) throw Object.assign(new Error("lead not found"), { status: 404 });
  db.query("UPDATE bookings SET lead_id = ? WHERE id = ?").run(leadId, bookingId);
  if (b.lead_id) db.query("UPDATE leads SET booking_id = NULL WHERE id = ? AND booking_id = ?").run(b.lead_id, bookingId);
  if (leadId) db.query("UPDATE leads SET booking_id = ? WHERE id = ?").run(bookingId, leadId);
  return getBooking(bookingId);
}

// ---------- invoices ----------
export interface LineItem { description?: string; person_id?: string; person_name?: string; hours?: number; rate_cents?: number; amount_cents: number; }
export interface Invoice {
  id: string; number: string; pod_id: string; period_start: string; period_end: string;
  line_items: LineItem[]; hours: number; amount_cents: number; status: string;
  stripe_invoice_id: string | null; qbo_id: string | null; due_at: string | null; created_at: string;
  pod_name?: string; client_name?: string;
}
function invoiceRow(r: any): Invoice {
  return { ...r, line_items: JSON.parse(r.line_items || "[]") };
}
export const listInvoices = () =>
  (db.query(
    `SELECT i.*, p.name AS pod_name, p.client_name FROM invoices i LEFT JOIN pods p ON p.id = i.pod_id ORDER BY i.created_at DESC`
  ).all() as any[]).map(invoiceRow);
export const getInvoice = (id: string) => {
  const r = db.query(
    `SELECT i.*, p.name AS pod_name, p.client_name FROM invoices i LEFT JOIN pods p ON p.id = i.pod_id WHERE i.id = ?`
  ).get(id) as any;
  return r ? invoiceRow(r) : null;
};
export function nextInvoiceNumber(year: number): string {
  const prefix = `INV-${year}-`;
  const r = db.query("SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(prefix + "%") as { number: string } | null;
  const n = r ? parseInt(r.number.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(3, "0");
}
/**
 * Draft an invoice for a pod over a date range. Hourly pods bill
 * hours × each person's rate; retainer pods bill the flat retainer rate.
 */
export function generateInvoice(p: { pod_id: string; period_start: string; period_end: string }): Invoice {
  const pod = getPod(p.pod_id);
  if (!pod) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!DAY_RE.test(p.period_start || "") || !DAY_RE.test(p.period_end || "") || p.period_start > p.period_end)
    throw Object.assign(new Error("need a valid period_start <= period_end (YYYY-MM-DD)"), { status: 400 });
  const entries = listEntries({ pod_id: p.pod_id, from: p.period_start, to: p.period_end }).filter((e) => e.billable);
  const hours = Math.round(entries.reduce((a, e) => a + e.hours, 0) * 100) / 100;
  let line_items: LineItem[]; let amount_cents: number;
  if (pod.billing_type === "retainer") {
    amount_cents = pod.retainer_rate_cents;
    line_items = [{ description: `Monthly retainer — ${pod.name} (${p.period_start} → ${p.period_end})`, hours, amount_cents }];
  } else {
    const byPerson = new Map<string, { name: string; hours: number; rate: number }>();
    for (const e of entries) {
      const person = getPerson(e.person_id); if (!person) continue;
      const g = byPerson.get(e.person_id) || { name: person.name, hours: 0, rate: person.hourly_rate_cents };
      g.hours += e.hours; byPerson.set(e.person_id, g);
    }
    line_items = [...byPerson.entries()].map(([person_id, g]) => ({
      person_id, person_name: g.name,
      hours: Math.round(g.hours * 100) / 100, rate_cents: g.rate,
      amount_cents: Math.round(g.hours * g.rate),
    }));
    amount_cents = line_items.reduce((a, l) => a + l.amount_cents, 0);
  }
  const year = Number(p.period_start.slice(0, 4));
  const row = {
    id: uid(), number: nextInvoiceNumber(year), pod_id: p.pod_id,
    period_start: p.period_start, period_end: p.period_end,
    line_items: JSON.stringify(line_items), hours, amount_cents,
    status: "draft", stripe_invoice_id: null as string | null, qbo_id: null as string | null,
    due_at: null as string | null, created_at: nowIso(),
  };
  db.query(`INSERT INTO invoices (id, number, pod_id, period_start, period_end, line_items, hours, amount_cents, status, stripe_invoice_id, qbo_id, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.number, row.pod_id, row.period_start, row.period_end, row.line_items, row.hours,
      row.amount_cents, row.status, row.stripe_invoice_id, row.qbo_id, row.due_at, row.created_at);
  return getInvoice(row.id)!;
}
export function sendInvoice(id: string, stripe?: { invoice_id: string }): Invoice {
  const inv = getInvoice(id);
  if (!inv) throw Object.assign(new Error("invoice not found"), { status: 404 });
  if (inv.status !== "draft") throw Object.assign(new Error("only drafts can be sent"), { status: 409 });
  const due = new Date(); due.setDate(due.getDate() + 14);
  db.query("UPDATE invoices SET status = 'sent', due_at = ?, stripe_invoice_id = COALESCE(?, stripe_invoice_id) WHERE id = ?")
    .run(localDay(due) , stripe?.invoice_id || null, id);
  return getInvoice(id)!;
}
export function voidInvoice(id: string): Invoice {
  const inv = getInvoice(id);
  if (!inv) throw Object.assign(new Error("invoice not found"), { status: 404 });
  if (inv.status === "paid") throw Object.assign(new Error("paid invoices cannot be voided"), { status: 409 });
  db.query("UPDATE invoices SET status = 'void' WHERE id = ?").run(id);
  return getInvoice(id)!;
}
export function markInvoicePaid(id: string): Invoice | null {
  const inv = getInvoice(id); if (!inv) return null;
  db.query("UPDATE invoices SET status = 'paid' WHERE id = ?").run(id);
  return getInvoice(id);
}
export const getInvoiceByStripeId = (sid: string) => {
  const r = db.query("SELECT * FROM invoices WHERE stripe_invoice_id = ?").get(sid) as any;
  return r ? invoiceRow(r) : null;
};
/** QBO/Xero-shaped CSV fallback — the always-works bridge. */
export function invoicesCsv(): string {
  const esc = (v: string | number | null) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = "invoice_number,client,pod,period_start,period_end,issue_date,due_date,description,hours,amount,status";
  const lines = listInvoices().flatMap((inv) =>
    inv.line_items.map((l) => [
      inv.number, inv.client_name || "", inv.pod_name || "", inv.period_start, inv.period_end,
      inv.created_at.slice(0, 10), inv.due_at || "",
      l.description || `${l.person_name || ""} — ${l.hours || 0}h @ ${l.rate_cents || 0}c`,
      l.hours ?? inv.hours, (l.amount_cents / 100).toFixed(2), inv.status,
    ].map(esc).join(","))
  );
  return head + "\n" + lines.join("\n") + "\n";
}

// ---------- Phase 3: billing clearinghouse & automated distribution ----------

/** The agency cut, percent. Firm setting `platform_spread_pct`, default 20, clamped 0–90. */
export function platformSpreadPct(): number {
  const raw = getSetting("platform_spread_pct");
  if (raw === "") return 20;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 90) return 20;
  return Math.round(v * 100) / 100;
}

/** Swappable "today" for tests: globalThis.__podiumToday or PODIUM_TODAY env. */
export function billingToday(): Date {
  const o = (globalThis as any).__podiumToday || process.env.PODIUM_TODAY;
  return o ? new Date(o) : new Date();
}
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/** First/last calendar day of a YYYY-MM month. */
export function monthBounds(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12)
    throw Object.assign(new Error("month must be YYYY-MM"), { status: 400 });
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

export interface SplitShare {
  person_id: string; person_name: string; hours: number;
  gross_cents: number; spread_cents: number; net_cents: number;
}
/**
 * Revenue split for a paid invoice: each exec's share = their billable hours ÷
 * total billable hours in the invoice period (even split among pod members when
 * nobody logged time, e.g. flat retainer). Largest-remainder on gross so the
 * shares sum to the invoice amount exactly; net = gross − spread per person so
 * Σ(spread + net) = amount always holds.
 */
export function computeSplit(invoiceId: string, spreadPct?: number): SplitShare[] {
  const inv = getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error("invoice not found"), { status: 404 });
  const pct = spreadPct ?? platformSpreadPct();
  const members = listMembers(inv.pod_id);
  if (!members.length) throw Object.assign(new Error("pod has no members to split between"), { status: 400 });
  const hoursBy = new Map<string, number>();
  for (const e of listEntries({ pod_id: inv.pod_id, from: inv.period_start, to: inv.period_end })) {
    if (!e.billable) continue;
    hoursBy.set(e.person_id, (hoursBy.get(e.person_id) || 0) + e.hours);
  }
  const total = [...hoursBy.values()].reduce((a, b) => a + b, 0);
  const weighted = members.map((m) => {
    const h = hoursBy.get(m.person_id) || 0;
    return { person_id: m.person_id, person_name: m.person_name || "", hours: h, w: total > 0 ? h / total : 1 / members.length };
  });
  const floored = weighted.map((x) => ({ ...x, floor: Math.floor(x.w * inv.amount_cents), frac: (x.w * inv.amount_cents) % 1 }));
  let remainder = inv.amount_cents - floored.reduce((a, f) => a + f.floor, 0);
  const extra = new Set<string>();
  for (const f of [...floored].sort((a, b) => b.frac - a.frac)) {
    if (remainder <= 0) break;
    extra.add(f.person_id); remainder--;
  }
  return floored.map((f) => {
    const gross = f.floor + (extra.has(f.person_id) ? 1 : 0);
    const spread = Math.round((gross * pct) / 100);
    return {
      person_id: f.person_id, person_name: f.person_name,
      hours: Math.round(f.hours * 100) / 100,
      gross_cents: gross, spread_cents: spread, net_cents: gross - spread,
    };
  });
}

export interface PayoutRow {
  id: string; invoice_id: string; person_id: string; person_name?: string;
  gross_cents: number; spread_cents: number; net_cents: number;
  status: string; stripe_transfer_id: string | null; failure: string; created_at: string;
}
/** Write the distribution ledger for an invoice. Idempotent — 409 if one exists. */
export function recordDistribution(invoiceId: string, mode: "dry_run" | "live", shares: SplitShare[]): { distribution: any; payouts: PayoutRow[] } {
  const inv = getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error("invoice not found"), { status: 404 });
  const existing = db.query("SELECT id FROM distributions WHERE invoice_id = ?").get(invoiceId);
  if (existing) throw Object.assign(new Error("this invoice was already distributed"), { status: 409 });
  const now = nowIso();
  const did = uid();
  const spreadPct = platformSpreadPct();
  db.query("INSERT INTO distributions (id, invoice_id, ran_at, mode, spread_pct, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(did, invoiceId, now, mode, spreadPct, now);
  for (const s of shares) {
    db.query(`INSERT INTO payouts (id, invoice_id, person_id, gross_cents, spread_cents, net_cents, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(uid(), invoiceId, s.person_id, s.gross_cents, s.spread_cents, s.net_cents, now);
  }
  return getDistribution(invoiceId)!;
}
export function getDistribution(invoiceId: string): { distribution: any; payouts: PayoutRow[] } | null {
  const d = db.query("SELECT * FROM distributions WHERE invoice_id = ?").get(invoiceId) as any;
  if (!d) return null;
  const payouts = db.query(
    `SELECT p.*, pe.name AS person_name FROM payouts p LEFT JOIN people pe ON pe.id = p.person_id
     WHERE p.invoice_id = ? ORDER BY p.net_cents DESC`
  ).all(invoiceId) as PayoutRow[];
  return { distribution: d, payouts };
}
export function listPayouts(f: { person_id?: string; status?: string } = {}): PayoutRow[] {
  let q = `SELECT p.*, pe.name AS person_name, i.number AS invoice_number FROM payouts p
    LEFT JOIN people pe ON pe.id = p.person_id LEFT JOIN invoices i ON i.id = p.invoice_id WHERE 1=1`;
  const args: any[] = [];
  if (f.person_id) { q += " AND p.person_id = ?"; args.push(f.person_id); }
  if (f.status) { q += " AND p.status = ?"; args.push(f.status); }
  return db.query(q + " ORDER BY p.created_at DESC").all(...args) as PayoutRow[];
}
export function markPayoutPaid(payoutId: string, transferId: string | null): void {
  db.query("UPDATE payouts SET status = 'paid', stripe_transfer_id = COALESCE(?, stripe_transfer_id), failure = '' WHERE id = ?")
    .run(transferId, payoutId);
}
export function markPayoutFailed(payoutId: string, failure: string): void {
  db.query("UPDATE payouts SET status = 'failed', failure = ? WHERE id = ?").run(String(failure).slice(0, 300), payoutId);
}
/** Live payouts are armed only when the firm flips the switch AND Stripe is connected. */
export function payoutsLiveArmed(): boolean {
  return getSetting("payouts_live") === "1" && !!activeStripeSecret();
}

// ---------- 1st-of-month billing runs ----------
export function listBillingRuns(): any[] {
  return (db.query("SELECT * FROM billing_runs ORDER BY run_month DESC").all() as any[]).map((r) => ({
    ...r, items: JSON.parse(r.invoice_ids || "[]"),
  }));
}
export function getBillingRun(month: string): any | null {
  const r = db.query("SELECT * FROM billing_runs WHERE run_month = ?").get(month) as any;
  return r ? { ...r, items: JSON.parse(r.invoice_ids || "[]") } : null;
}
export function recordBillingRun(month: string, items: any[]): any {
  const now = nowIso();
  db.query("INSERT INTO billing_runs (id, run_month, ran_at, invoice_ids, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_month) DO UPDATE SET ran_at = excluded.ran_at, invoice_ids = excluded.invoice_ids")
    .run(uid(), month, now, JSON.stringify(items), now);
  return getBillingRun(month);
}

export { db };

// ---------- integration bookkeeping (keeps raw SQL out of server.ts) ----------
export function setPodStripeIds(podId: string, customerId: string, subscriptionId: string): void {
  db.query("UPDATE pods SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?")
    .run(customerId, subscriptionId, podId);
}
export function setPodStripeCustomer(podId: string, customerId: string): void {
  db.query("UPDATE pods SET stripe_customer_id = ? WHERE id = ?").run(customerId, podId);
}
export function setPodSlackChannel(podId: string, channelId: string): void {
  db.query("UPDATE pods SET slack_channel_id = ? WHERE id = ?").run(channelId, podId);
}
export function setPodClickupList(podId: string, listId: string): void {
  db.query("UPDATE pods SET clickup_list_id = ? WHERE id = ?").run(listId, podId);
}
export function setInvoiceQboId(id: string, qboId: string): void {
  db.query("UPDATE invoices SET qbo_id = ? WHERE id = ?").run(qboId, id);
}

// ---------- Phase 2: objectives & key results ----------
export interface KeyResult { id: string; objective_id: string; title: string; target: string; current: string; created_at: string; }
export interface Objective { id: string; pod_id: string; title: string; period: string; progress_pct: number; status: string; created_at: string; key_results: KeyResult[]; }
export const OBJECTIVE_STATUSES = ["on_track", "at_risk", "done"];
function validObjectiveStatus(v: unknown): string {
  const s = String(v || "on_track").toLowerCase();
  if (!OBJECTIVE_STATUSES.includes(s)) throw Object.assign(new Error("status must be one of " + OBJECTIVE_STATUSES.join(", ")), { status: 400 });
  return s;
}
function validProgress(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw Object.assign(new Error("progress_pct must be 0–100"), { status: 400 });
  return n;
}
export function listObjectives(podId: string): Objective[] {
  return (db.query("SELECT * FROM objectives WHERE pod_id = ? ORDER BY created_at").all(podId) as any[])
    .map((o) => ({ ...o, key_results: listKeyResults(o.id) }));
}
export function getObjective(id: string): Objective | null {
  const o = db.query("SELECT * FROM objectives WHERE id = ?").get(id) as any;
  return o ? { ...o, key_results: listKeyResults(o.id) } : null;
}
export function createObjective(podId: string, p: { title: string; period?: string; progress_pct?: number; status?: string }): Objective {
  if (!getPod(podId)) throw Object.assign(new Error("pod not found"), { status: 404 });
  if (!p.title?.trim()) throw Object.assign(new Error("title is required"), { status: 400 });
  const row = { id: uid(), pod_id: podId, title: p.title.trim(), period: String(p.period || "").trim().slice(0, 12), progress_pct: p.progress_pct == null ? 0 : validProgress(p.progress_pct), status: validObjectiveStatus(p.status), created_at: nowIso() };
  db.query("INSERT INTO objectives (id, pod_id, title, period, progress_pct, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.pod_id, row.title, row.period, row.progress_pct, row.status, row.created_at);
  return getObjective(row.id)!;
}
export function updateObjective(id: string, p: { title?: string; period?: string; progress_pct?: number; status?: string }): Objective | null {
  const cur = db.query("SELECT * FROM objectives WHERE id = ?").get(id) as any;
  if (!cur) return null;
  const next = {
    title: (p.title ?? cur.title).trim() || cur.title,
    period: String(p.period ?? cur.period).trim().slice(0, 12),
    progress_pct: p.progress_pct == null ? cur.progress_pct : validProgress(p.progress_pct),
    status: p.status === undefined ? cur.status : validObjectiveStatus(p.status),
  };
  db.query("UPDATE objectives SET title = ?, period = ?, progress_pct = ?, status = ? WHERE id = ?")
    .run(next.title, next.period, next.progress_pct, next.status, id);
  return getObjective(id);
}
export function deleteObjective(id: string): boolean {
  db.query("DELETE FROM key_results WHERE objective_id = ?").run(id);
  return db.query("DELETE FROM objectives WHERE id = ?").run(id).changes > 0;
}
export function listKeyResults(objectiveId: string): KeyResult[] {
  return db.query("SELECT * FROM key_results WHERE objective_id = ? ORDER BY created_at").all(objectiveId) as KeyResult[];
}
export function createKeyResult(objectiveId: string, p: { title: string; target?: string; current?: string }): KeyResult {
  if (!db.query("SELECT 1 FROM objectives WHERE id = ?").get(objectiveId))
    throw Object.assign(new Error("objective not found"), { status: 404 });
  if (!p.title?.trim()) throw Object.assign(new Error("title is required"), { status: 400 });
  const row = { id: uid(), objective_id: objectiveId, title: p.title.trim(), target: String(p.target || "").trim().slice(0, 200), current: String(p.current || "").trim().slice(0, 200), created_at: nowIso() };
  db.query("INSERT INTO key_results (id, objective_id, title, target, current, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.objective_id, row.title, row.target, row.current, row.created_at);
  return db.query("SELECT * FROM key_results WHERE id = ?").get(row.id) as KeyResult;
}
export function updateKeyResult(id: string, p: { title?: string; target?: string; current?: string }): KeyResult | null {
  const cur = db.query("SELECT * FROM key_results WHERE id = ?").get(id) as any;
  if (!cur) return null;
  const next = {
    title: (p.title ?? cur.title).trim() || cur.title,
    target: String(p.target ?? cur.target).trim().slice(0, 200),
    current: String(p.current ?? cur.current).trim().slice(0, 200),
  };
  db.query("UPDATE key_results SET title = ?, target = ?, current = ? WHERE id = ?")
    .run(next.title, next.target, next.current, id);
  return db.query("SELECT * FROM key_results WHERE id = ?").get(id) as KeyResult;
}
export function deleteKeyResult(id: string): boolean {
  return db.query("DELETE FROM key_results WHERE id = ?").run(id).changes > 0;
}

// ---------- Phase 2: scope-drift alerts ----------
export interface Alert { id: string; pod_id: string; kind: string; message: string; seen: number; created_at: string; pod_name?: string; }
export function listAlerts(unseenOnly = false): Alert[] {
  const rows = db.query(
    `SELECT a.*, p.name AS pod_name FROM alerts a LEFT JOIN pods p ON p.id = a.pod_id
     ${unseenOnly ? "WHERE a.seen = 0" : ""} ORDER BY a.created_at DESC LIMIT 100`
  ).all() as Alert[];
  return rows;
}
export function unseenAlertCount(): number {
  return (db.query("SELECT COUNT(*) AS c FROM alerts WHERE seen = 0").get() as { c: number }).c;
}
export function markAlertSeen(id: string): boolean {
  return db.query("UPDATE alerts SET seen = 1 WHERE id = ?").run(id).changes > 0;
}
function monthStart(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
/** Create an alert unless one of the same kind already exists for this pod this month. */
function createAlertOnce(podId: string, kind: string, message: string): Alert | null {
  const dup = db.query("SELECT 1 FROM alerts WHERE pod_id = ? AND kind = ? AND created_at >= ?").get(podId, kind, monthStart());
  if (dup) return null;
  const row = { id: uid(), pod_id: podId, kind, message, seen: 0, created_at: nowIso() };
  db.query("INSERT INTO alerts (id, pod_id, kind, message, seen, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.pod_id, row.kind, row.message, row.seen, row.created_at);
  return { ...row, pod_name: getPod(podId)?.name } as Alert;
}
/** Recompute retainer usage after a time entry lands; fire 80%/100% alerts at first crossing. Returns any new alert. */
export function checkRetainerAlerts(podId: string): Alert | null {
  const pod = getPod(podId);
  if (!pod || pod.billing_type !== "retainer" || !pod.retainer_hours) return null;
  const usage = retainerUsage(podId);
  if (!usage) return null;
  const link = `#/pod/${podId}/time`;
  if (usage.pct >= 1) {
    return createAlertOnce(podId, "overage_100",
      `${pod.name} hit 100% of its ${usage.cap}h retainer (${usage.hours}h logged). Adjust the retainer: ${link}`);
  }
  if (usage.pct >= 0.8) {
    return createAlertOnce(podId, "overage_80",
      `${pod.name} is at ${Math.round(usage.pct * 100)}% of its ${usage.cap}h retainer (${usage.hours}h logged). Consider an upsell or retainer adjustment: ${link}`);
  }
  return null;
}

// ---------- Phase 2: SOW e-signing (built-in ceremony, no third party) ----------
import { createHash } from "node:crypto";
export interface PageSigning { id: string; page_id: string; token: string; signer_name: string; signer_email: string; status: string; signed_at: string | null; signature_hash: string; created_at: string; }
function signingToken(): string {
  const b = new Uint8Array(32);
  (globalThis.crypto as any).getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function getPageSigningForPage(pageId: string): PageSigning | null {
  return (db.query("SELECT * FROM page_signings WHERE page_id = ? ORDER BY created_at DESC LIMIT 1").get(pageId) as PageSigning) || null;
}
export function getSigningByToken(token: string): (PageSigning & { page_title?: string; page_body?: string }) | null {
  const s = db.query(
    `SELECT s.*, p.title AS page_title, p.body_md AS page_body FROM page_signings s
     JOIN pages p ON p.id = s.page_id WHERE s.token = ?`
  ).get(token) as any;
  return s || null;
}
export function createPageSigning(pageId: string, p: { signer_name: string; signer_email: string }): PageSigning {
  if (!getPage(pageId)) throw Object.assign(new Error("page not found"), { status: 404 });
  const email = String(p.signer_email || "").trim();
  if (!p.signer_name?.trim()) throw Object.assign(new Error("signer_name is required"), { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("a valid signer_email is required"), { status: 400 });
  db.query("DELETE FROM page_signings WHERE page_id = ?").run(pageId); // one active ceremony per page
  const row: PageSigning = { id: uid(), page_id: pageId, token: signingToken(), signer_name: p.signer_name.trim().slice(0, 120), signer_email: email.slice(0, 160), status: "pending", signed_at: null, signature_hash: "", created_at: nowIso() };
  db.query("INSERT INTO page_signings (id, page_id, token, signer_name, signer_email, status, signed_at, signature_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.page_id, row.token, row.signer_name, row.signer_email, row.status, row.signed_at, row.signature_hash, row.created_at);
  return row;
}
export function revokePageSigning(pageId: string): boolean {
  return db.query("DELETE FROM page_signings WHERE page_id = ?").run(pageId).changes > 0;
}
/** The signature hash binds the exact page body to the signer + moment. Deterministic and verifiable. */
export function signatureHash(pageBody: string, signerName: string, signerEmail: string, signedAt: string): string {
  return createHash("sha256").update(`${pageBody}\n${signerName}\n${signerEmail}\n${signedAt}`).digest("hex");
}
export function signPageSigning(token: string, signerName: string): PageSigning {
  const s = getSigningByToken(token);
  if (!s) throw Object.assign(new Error("signing link not found or revoked"), { status: 404 });
  if (s.status === "signed") throw Object.assign(new Error("already signed"), { status: 409 });
  const name = String(signerName || "").trim();
  if (!name) throw Object.assign(new Error("signer_name is required"), { status: 400 });
  const signedAt = nowIso();
  const hash = signatureHash(s.page_body || "", name, s.signer_email, signedAt);
  db.query("UPDATE page_signings SET status = 'signed', signed_at = ?, signature_hash = ?, signer_name = ? WHERE id = ?")
    .run(signedAt, hash, name.slice(0, 120), s.id);
  return getSigningByToken(token)!;
}

// ---------- Phase 2: public intake → lead ----------
const INTAKE_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function createIntakeLead(p: { name: string; company: string; email: string; phone?: string; needs?: string; budget_band?: string; contact_method?: string }): Lead {
  const name = String(p.name || "").trim();
  const company = String(p.company || "").trim();
  const email = String(p.email || "").trim();
  if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
  if (!company) throw Object.assign(new Error("company is required"), { status: 400 });
  if (!INTAKE_EMAIL_RE.test(email)) throw Object.assign(new Error("a valid email is required"), { status: 400 });
  return createLead({
    name, company, email,
    phone: String(p.phone || "").trim().slice(0, 40),
    source: "intake", temperature: "warm", priority: 4,
    notes: String(p.needs || "").trim().slice(0, 2000),
    budget_band: p.budget_band, contact_method: p.contact_method,
  });
}
