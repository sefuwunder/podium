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
  `);
}

// ---------- people ----------
export interface Person { id: string; name: string; email: string; title: string; hourly_rate_cents: number; created_at: string; }
export const listPeople = () => db.query("SELECT * FROM people ORDER BY name COLLATE NOCASE").all() as Person[];
export const getPerson = (id: string) => (db.query("SELECT * FROM people WHERE id = ?").get(id) as Person) || null;
export function createPerson(p: { name: string; email?: string; title?: string; hourly_rate_cents?: number }): Person {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const rate = Math.round(Number(p.hourly_rate_cents) || 0);
  if (rate < 0) throw Object.assign(new Error("hourly_rate_cents must be >= 0"), { status: 400 });
  const row: Person = { id: uid(), name: p.name.trim(), email: (p.email || "").trim(), title: (p.title || "").trim(), hourly_rate_cents: rate, created_at: nowIso() };
  db.query("INSERT INTO people (id, name, email, title, hourly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.email, row.title, row.hourly_rate_cents, row.created_at);
  return row;
}
export function updatePerson(id: string, p: Partial<Person>): Person | null {
  const cur = getPerson(id); if (!cur) return null;
  const row = {
    name: (p.name ?? cur.name).trim() || cur.name,
    email: (p.email ?? cur.email).trim(),
    title: (p.title ?? cur.title).trim(),
    hourly_rate_cents: p.hourly_rate_cents == null ? cur.hourly_rate_cents : Math.max(0, Math.round(Number(p.hourly_rate_cents) || 0)),
  };
  db.query("UPDATE people SET name = ?, email = ?, title = ?, hourly_rate_cents = ? WHERE id = ?")
    .run(row.name, row.email, row.title, row.hourly_rate_cents, id);
  return getPerson(id);
}
export function deletePerson(id: string): boolean {
  return db.query("DELETE FROM people WHERE id = ?").run(id).changes > 0;
}

// ---------- pods ----------
export interface Pod { id: string; name: string; client_name: string; color: string; created_at: string; }
export const listPods = () => db.query("SELECT * FROM pods ORDER BY name COLLATE NOCASE").all() as Pod[];
export const getPod = (id: string) => (db.query("SELECT * FROM pods WHERE id = ?").get(id) as Pod) || null;
export function createPod(p: { name: string; client_name?: string; color?: string }): Pod {
  if (!p.name?.trim()) throw Object.assign(new Error("name is required"), { status: 400 });
  const row: Pod = { id: uid(), name: p.name.trim(), client_name: (p.client_name || "").trim(), color: p.color || "#c96f4a", created_at: nowIso() };
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
  return db.query("DELETE FROM pods WHERE id = ?").run(id).changes > 0;
}

// ---------- members ----------
export interface PodMember { pod_id: string; person_id: string; role: string; joined_at: string; person_name?: string; }
export function listMembers(podId: string): PodMember[] {
  return db.query(
    `SELECT m.*, p.name AS person_name FROM pod_members m JOIN people p ON p.id = m.person_id
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
export interface TimeEntry { id: string; person_id: string; pod_id: string; day: string; hours: number; note: string; billable: number; period_id: string | null; created_at: string; person_name?: string; pod_name?: string; }
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
export function createEntry(p: { person_id: string; pod_id: string; day: string; hours: number; note?: string; billable?: number }): TimeEntry {
  const hours = validateTime(p);
  const row = { id: uid(), person_id: p.person_id, pod_id: p.pod_id, day: p.day, hours, note: (p.note || "").trim(), billable: p.billable === 0 ? 0 : 1, period_id: null as string | null, created_at: nowIso() };
  db.query("INSERT INTO time_entries (id, person_id, pod_id, day, hours, note, billable, period_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.person_id, row.pod_id, row.day, row.hours, row.note, row.billable, row.period_id, row.created_at);
  return row as TimeEntry;
}
export function updateEntry(id: string, p: { day?: string; hours?: number; note?: string; billable?: number; pod_id?: string }): TimeEntry | null {
  const cur = getEntry(id); if (!cur) return null;
  if (entryLocked(id)) throw Object.assign(new Error("entry is in a closed pay period"), { status: 403 });
  const next = { person_id: cur.person_id, pod_id: p.pod_id || cur.pod_id, day: p.day || cur.day, hours: p.hours ?? cur.hours };
  const hours = validateTime(next);
  db.query("UPDATE time_entries SET pod_id = ?, day = ?, hours = ?, note = ?, billable = ? WHERE id = ?")
    .run(next.pod_id, next.day, hours, (p.note ?? cur.note).trim(), p.billable === undefined ? cur.billable : (p.billable ? 1 : 0), id);
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
export function weekRange(dayIso?: string): { from: string; to: string } {
  const d = dayIso && DAY_RE.test(dayIso) ? new Date(dayIso + "T12:00:00Z") : new Date();
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
  return { week: { from, to }, hoursPerPod: perPod, openPeriod: per, openPeriodPerPerson: perPerson };
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
  console.log("seeded Podium: 2 pods, 7 people, channels, messages, pages, time entries, 1 open period");
}

export { db };
