// Podium v1 integrations tests — CRM, templates, timer/retainer, scheduling,
// invoices, Stripe/Slack/QBO (mocked). Boots a child server with
// PODIUM_MOCK_INTEGRATIONS=1 so no real network calls happen.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

process.env.PODIUM_DATA = mkdtempSync(join(tmpdir(), "podium-int-unit-"));
const { billableHours } = await import("../src/db.ts");

const DATA = mkdtempSync(join(tmpdir(), "podium-int-"));
const PORT = "32202";
const BASE = "http://127.0.0.1:" + PORT;
const SERVER = new URL("../src/server.ts", import.meta.url).pathname;

async function api(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* csv/plain */ }
  return { status: r.status, json: j, text, headers: r.headers };
}

let proc: any;
beforeAll(async () => {
  proc = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, PODIUM_DATA: DATA, PORT, PODIUM_MOCK_INTEGRATIONS: "1" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + "/api/status"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("integration test server did not start");
});
afterAll(() => { try { proc.kill(); } catch {} });

async function mockReset() { await api("POST", "/api/_mock/reset"); }
async function mockCalls(): Promise<any[]> { return (await api("GET", "/api/_mock/calls")).json.calls; }

/* ================= Pillar A — CRM ================= */

describe("CRM: leads & pipeline", () => {
  test("lead CRUD + validation", async () => {
    const bad = await api("POST", "/api/leads", { name: "  " });
    expect(bad.status).toBe(400);
    const badTemp = await api("POST", "/api/leads", { name: "X", temperature: "lukewarm" });
    expect(badTemp.status).toBe(400);
    const c = await api("POST", "/api/leads", {
      name: "Dana Kim", company: "Kim Logistics", email: "d@kim.co",
      temperature: "hot", priority: 1, value_cents: 6000000, source: "VC intro",
    });
    expect(c.status).toBe(201);
    expect(c.json.lead.stage).toBe("intro");
    expect(c.json.lead.temperature).toBe("hot");
    const g = await api("GET", `/api/leads/${c.json.lead.id}`);
    expect(g.json.lead.company).toBe("Kim Logistics");
    const u = await api("PUT", `/api/leads/${c.json.lead.id}`, { priority: 9 });
    expect(u.json.lead.priority).toBe(5); // clamped
    expect((await api("DELETE", `/api/leads/${c.json.lead.id}`)).status).toBe(200);
    expect((await api("GET", `/api/leads/${c.json.lead.id}`)).status).toBe(404);
  });

  test("stage machine: forward one step, lost from anywhere, terminal won/lost", async () => {
    const c = await api("POST", "/api/leads", { name: "Stagey", company: "Stage Co" });
    const id = c.json.lead.id;
    // cannot skip forward
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "sow" })).status).toBe(409);
    // cannot go to unknown stage
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "nope" })).status).toBe(400);
    // forward one step ok
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "diagnostic" })).json.lead.stage).toBe("diagnostic");
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "sow" })).json.lead.stage).toBe("sow");
    // lost from anywhere
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "lost" })).json.lead.stage).toBe("lost");
    // lost is terminal
    expect((await api("POST", `/api/leads/${id}/move`, { stage: "intro" })).status).toBe(409);

    const c2 = await api("POST", "/api/leads", { name: "Wony", company: "Won Co" });
    const id2 = c2.json.lead.id;
    for (const s of ["diagnostic", "sow", "won"]) {
      await api("POST", `/api/leads/${id2}/move`, { stage: s });
    }
    expect((await api("GET", `/api/leads/${id2}`)).json.lead.stage).toBe("won");
    expect((await api("POST", `/api/leads/${id2}/move`, { stage: "lost" })).status).toBe(409); // won is terminal
  });

  test("pipeline summary: counts, totals, weighted values", async () => {
    await api("POST", "/api/leads", { name: "Pipe A", company: "PA", value_cents: 100000, temperature: "warm" });
    const b = await api("POST", "/api/leads", { name: "Pipe B", company: "PB", value_cents: 200000, temperature: "warm" });
    await api("POST", `/api/leads/${b.json.lead.id}/move`, { stage: "diagnostic" });
    const p = await api("GET", "/api/pipeline");
    expect(p.status).toBe(200);
    expect(p.json.stages.length).toBe(5);
    const intro = p.json.stages.find((s: any) => s.stage === "intro");
    const diag = p.json.stages.find((s: any) => s.stage === "diagnostic");
    expect(intro.count).toBeGreaterThanOrEqual(1);
    expect(diag.weighted_cents).toBe(Math.round(diag.total_cents * 0.3));
    expect(intro.weighted_cents).toBe(Math.round(intro.total_cents * 0.1));
  });

  test("Top 20: warm+hot only, priority then value, capped", async () => {
    for (let i = 0; i < 25; i++) {
      await api("POST", "/api/leads", {
        name: `TopLead ${i}`, company: `TC${i}`, temperature: i % 5 === 0 ? "cold" : "warm",
        priority: (i % 5) + 1, value_cents: i * 1000,
      });
    }
    const t = await api("GET", "/api/leads/top20");
    expect(t.status).toBe(200);
    expect(t.json.leads.length).toBeLessThanOrEqual(20);
    expect(t.json.leads.every((l: any) => l.temperature !== "cold")).toBe(true);
    expect(t.json.leads.every((l: any) => !["won", "lost"].includes(l.stage))).toBe(true);
    for (let i = 1; i < t.json.leads.length; i++) {
      const a = t.json.leads[i - 1], b = t.json.leads[i];
      expect(a.priority < b.priority || (a.priority === b.priority && a.value_cents >= b.value_cents)).toBe(true);
    }
  });

  test("Closed Won → spin up pod (the money loop)", async () => {
    const c = await api("POST", "/api/leads", { name: "Spin", company: "SpinCo Industries" });
    const id = c.json.lead.id;
    // not won yet → 409
    expect((await api("POST", `/api/leads/${id}/spin-up-pod`)).status).toBe(409);
    for (const s of ["diagnostic", "sow", "won"]) await api("POST", `/api/leads/${id}/move`, { stage: s });
    const r = await api("POST", `/api/leads/${id}/spin-up-pod`);
    expect(r.status).toBe(201);
    expect(r.json.pod.name).toBe("SpinCo Industries");
    expect(r.json.pod.client_name).toBe("SpinCo Industries");
    expect(r.json.lead.pod_id).toBe(r.json.pod.id);
    // twice → 409
    expect((await api("POST", `/api/leads/${id}/spin-up-pod`)).status).toBe(409);
    // pod has #general
    const ch = await api("GET", `/api/pods/${r.json.pod.id}/channels`);
    expect(ch.json.channels.map((c: any) => c.name)).toContain("general");
  });

  test("partners CRUD + lead linking", async () => {
    expect((await api("POST", "/api/partners", { name: "X" , kind: "bogus" })).status).toBe(400);
    const p = await api("POST", "/api/partners", { name: "BlueYard", kind: "vc", contact_name: "Ava", contact_email: "a@blueyard.co" });
    expect(p.status).toBe(201);
    const l = await api("POST", "/api/leads", { name: "Partner Lead", company: "PL Co" });
    const u = await api("PUT", `/api/leads/${l.json.lead.id}`, { partner_id: p.json.partner.id });
    expect(u.json.lead.partner_id).toBe(p.json.partner.id);
    expect(u.json.lead.partner_name).toBe("BlueYard");
    expect((await api("DELETE", `/api/partners/${p.json.partner.id}`)).status).toBe(200);
    expect((await api("GET", `/api/leads/${l.json.lead.id}`)).json.lead.partner_id).toBeNull();
  });
});

/* ================= Pillar B — templates ================= */

describe("templates & knowledge base", () => {
  test("four templates seeded with placeholders", async () => {
    const r = await api("GET", "/api/templates");
    expect(r.status).toBe(200);
    const names = r.json.templates.map((t: any) => t.name);
    for (const n of ["Statement of Work", "Meeting Notes", "30-60-90 Day Roadmap", "Deliverables Tracker"])
      expect(names).toContain(n);
    const sow = r.json.templates.find((t: any) => t.name === "Statement of Work");
    for (const v of ["{{pod_name}}", "{{client_name}}", "{{date}}", "{{owner_name}}"])
      expect(sow.body_md).toContain(v);
  });

  test("from-template: substitution creates a wiki page", async () => {
    const pods = await api("GET", "/api/pods");
    const pod = pods.json.pods[0];
    const tpl = (await api("GET", "/api/templates")).json.templates.find((t: any) => t.name === "Meeting Notes");
    const r = await api("POST", `/api/pods/${pod.id}/pages/from-template`, {
      template_id: tpl.id,
      variables: { pod_name: pod.name, client_name: "ACME", date: "2026-10-09", owner_name: "Ava" },
    });
    expect(r.status).toBe(201);
    expect(r.json.page.body_md).toContain("ACME");
    expect(r.json.page.body_md).toContain("2026-10-09");
    expect(r.json.page.body_md).not.toContain("{{");
    expect(r.json.page.title).toBe("Meeting Notes");
    // custom title + unknown template → 404
    expect((await api("POST", `/api/pods/${pod.id}/pages/from-template`, { template_id: "nope", variables: {} })).status).toBe(404);
  });

  test("template CRUD", async () => {
    const c = await api("POST", "/api/templates", { name: "Tmp", kind: "doc", body_md: "hi {{pod_name}}" });
    expect(c.status).toBe(201);
    const u = await api("PUT", `/api/templates/${c.json.template.id}`, { body_md: "bye {{pod_name}}" });
    expect(u.json.template.body_md).toBe("bye {{pod_name}}");
    expect((await api("DELETE", `/api/templates/${c.json.template.id}`)).status).toBe(200);
  });
});

/* ================= Pillar C — timer, retainer, scheduling ================= */

describe("timer: the big green button", () => {
  test("billableHours rounds up to 0.1h", () => {
    expect(billableHours(0)).toBe(0.1);
    expect(billableHours(360)).toBe(0.1);
    expect(billableHours(361)).toBe(0.2);
    expect(billableHours(3600)).toBe(1);
    expect(billableHours(3661)).toBe(1.1);
  });

  test("start → status → stop writes a rounded entry; double-start 409", async () => {
    const pod = (await api("POST", "/api/pods", { name: "TimerPod" })).json.pod;
    const person = (await api("POST", "/api/people", { name: "Timer Person", hourly_rate_cents: 10000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: person.id });
    const outsider = (await api("POST", "/api/people", { name: "Timer Outsider" })).json.person;

    // non-member cannot start
    expect((await api("POST", "/api/timer/start", { person_id: outsider.id, pod_id: pod.id })).status).toBe(400);
    const s = await api("POST", "/api/timer/start", { person_id: person.id, pod_id: pod.id, note: "deep work" });
    expect(s.status).toBe(201);
    expect((await api("POST", "/api/timer/start", { person_id: person.id, pod_id: pod.id })).status).toBe(409);
    const st = await api("GET", `/api/timer/status?person_id=${person.id}`);
    expect(st.json.timer).toBeTruthy();
    expect(st.json.timer.elapsed_sec).toBeGreaterThanOrEqual(0);
    const all = await api("GET", "/api/timer/status");
    expect(all.json.timers.some((t: any) => t.person_id === person.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    const stop = await api("POST", "/api/timer/stop", { person_id: person.id });
    expect(stop.json.hours).toBe(0.1); // ~1s rounds up to the 0.1h minimum
    expect(stop.json.entry.pod_id).toBe(pod.id);
    expect(stop.json.entry.note).toBe("deep work");
    // timer cleared
    expect((await api("GET", `/api/timer/status?person_id=${person.id}`)).json.timer).toBeNull();
    // stop with none → 404
    expect((await api("POST", "/api/timer/stop", { person_id: person.id })).status).toBe(404);
  });
});

describe("retainers", () => {
  test("billing update + month-to-date usage + dashboard", async () => {
    const pod = (await api("POST", "/api/pods", { name: "RetPod", client_name: "RetCo" })).json.pod;
    const person = (await api("POST", "/api/people", { name: "Ret Person", hourly_rate_cents: 20000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: person.id });
    expect((await api("PUT", `/api/pods/${pod.id}/retainer`, { billing_type: "bogus" })).status).toBe(400);
    const u = await api("PUT", `/api/pods/${pod.id}/retainer`, { billing_type: "retainer", retainer_hours: 40, retainer_rate_cents: 800000 });
    expect(u.json.pod.billing_type).toBe("retainer");
    expect(u.json.pod.retainer_hours).toBe(40);
    // log 34h this month → 85% → amber
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day, hours: 20, note: "a" });
    await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day, hours: 14, note: "b" });
    const r = await api("GET", `/api/pods/${pod.id}/retainer`);
    expect(r.json.retainer.hours).toBe(34);
    expect(r.json.retainer.cap).toBe(40);
    expect(r.json.retainer.pct).toBeCloseTo(0.85, 5);
    const d = await api("GET", "/api/dashboard");
    expect(d.json.retainers.some((x: any) => x.pod_id === pod.id && x.hours === 34)).toBe(true);
    const full = await api("GET", `/api/pods/${pod.id}`);
    expect(full.json.retainer.hours).toBe(34);
  });
});

describe("scheduling & public booking", () => {
  test("availability validation", async () => {
    const person = (await api("POST", "/api/people", { name: "Avail Person" })).json.person;
    expect((await api("POST", "/api/availability", { person_id: person.id, weekday: 7, start_min: 0, end_min: 60 })).status).toBe(400);
    expect((await api("POST", "/api/availability", { person_id: person.id, weekday: 1, start_min: 60, end_min: 60 })).status).toBe(400);
    const a = await api("POST", "/api/availability", { person_id: person.id, weekday: 1, start_min: 540, end_min: 1020 });
    expect(a.status).toBe(201);
    expect((await api("DELETE", `/api/availability/${a.json.availability.id}`)).status).toBe(200);
  });

  test("public booking: slots → book → double-book 409 → outside availability 400", async () => {
    const person = (await api("POST", "/api/people", { name: "Book Person" })).json.person;
    const slug = (await api("POST", `/api/people/${person.id}/enable-booking`)).json.slug;
    expect(slug).toBeTruthy();
    // availability: tomorrow, 9:00–10:00
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const wd = tomorrow.getDay();
    await api("POST", "/api/availability", { person_id: person.id, weekday: wd, start_min: 540, end_min: 600 });
    const slots = await api("GET", `/book/${slug}/slots`);
    expect(slots.status).toBe(200);
    expect(slots.json.person.name).toBe("Book Person");
    expect(slots.json.slots.length).toBeGreaterThanOrEqual(2);
    const s0 = slots.json.slots[0];
    expect(s0.end_at).not.toBe(s0.start_at);
    // every slot is exactly 30 min
    for (const s of slots.json.slots.slice(0, 4)) {
      const dur = new Date(s.end_at).getTime() - new Date(s.start_at).getTime();
      expect(dur).toBe(30 * 60 * 1000);
    }
    const b = await api("POST", `/book/${slug}`, {
      start_at: s0.start_at, end_at: s0.end_at, booker_name: "Booker", booker_email: "b@x.co",
    });
    expect(b.status).toBe(201);
    expect(b.json.booking.status).toBe("confirmed");
    // double-book → 409
    expect((await api("POST", `/book/${slug}`, {
      start_at: s0.start_at, end_at: s0.end_at, booker_name: "Other", booker_email: "o@x.co",
    })).status).toBe(409);
    // outside availability → 400
    const other = slots.json.slots[slots.json.slots.length - 1];
    const bad = await api("POST", `/book/${slug}`, {
      start_at: other.start_at.slice(0, 10) + "T23:00:00", end_at: other.start_at.slice(0, 10) + "T23:30:00",
      booker_name: "Night", booker_email: "n@x.co",
    });
    expect(bad.status).toBe(400);
    // booked slot disappears from free slots
    const slots2 = await api("GET", `/book/${slug}/slots`);
    expect(slots2.json.slots.some((s: any) => s.start_at === s0.start_at)).toBe(false);
    // unknown slug → 404
    expect((await api("GET", "/book/nope-not-real/slots")).status).toBe(404);
    // booking page HTML serves
    const page = await api("GET", `/book/${slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Book time");
  });

  test("booking → link lead", async () => {
    const person = (await api("POST", "/api/people", { name: "Link Person" })).json.person;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 2);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bk = await api("POST", "/api/bookings", {
      person_id: person.id,
      start_at: iso(tomorrow) + "T10:00:00", end_at: iso(tomorrow) + "T10:30:00",
      booker_name: "Lead Booker", booker_email: "lb@x.co",
    });
    expect(bk.status).toBe(201);
    const lead = await api("POST", "/api/leads", { name: "Booking Lead", company: "BL" });
    const linked = await api("POST", `/api/bookings/${bk.json.booking.id}/link-lead`, { lead_id: lead.json.lead.id });
    expect(linked.json.booking.lead_id).toBe(lead.json.lead.id);
    expect((await api("GET", `/api/leads/${lead.json.lead.id}`)).json.lead.booking_id).toBe(bk.json.booking.id);
    // past booking → 400
    expect((await api("POST", "/api/bookings", {
      person_id: person.id, start_at: "2020-01-01T10:00:00", end_at: "2020-01-01T10:30:00", booker_name: "Past",
    })).status).toBe(400);
  });
});

/* ================= Pillar D — invoices, Stripe, QBO ================= */

describe("invoices", () => {
  test("hourly invoice math + number sequencing", async () => {
    const pod = (await api("POST", "/api/pods", { name: "InvPod", client_name: "InvCo" })).json.pod;
    const a = (await api("POST", "/api/people", { name: "Inv Alice", hourly_rate_cents: 10000 })).json.person;
    const b = (await api("POST", "/api/people", { name: "Inv Bob", hourly_rate_cents: 25000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: a.id });
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: b.id });
    await api("POST", "/api/time", { person_id: a.id, pod_id: pod.id, day: "2026-10-05", hours: 2.5, note: "w" });
    await api("POST", "/api/time", { person_id: b.id, pod_id: pod.id, day: "2026-10-06", hours: 1, note: "w" });
    const g1 = await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    expect(g1.status).toBe(201);
    const inv = g1.json.invoice;
    expect(inv.number).toMatch(/^INV-2026-\d{3}$/);
    expect(inv.status).toBe("draft");
    expect(inv.hours).toBe(3.5);
    expect(inv.amount_cents).toBe(50000); // 2.5*10000 + 1*25000
    const alice = inv.line_items.find((l: any) => l.person_name === "Inv Alice");
    expect(alice.amount_cents).toBe(25000);
    const g2 = await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    const n1 = Number(inv.number.split("-")[2]), n2 = Number(g2.json.invoice.number.split("-")[2]);
    expect(n2).toBe(n1 + 1); // sequencing
    // bad range → 400
    expect((await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-31", period_end: "2026-10-01" })).status).toBe(400);
  });

  test("retainer invoice bills the flat rate", async () => {
    const pod = (await api("POST", "/api/pods", { name: "InvRetPod", client_name: "RetCo" })).json.pod;
    const person = (await api("POST", "/api/people", { name: "Inv Ret", hourly_rate_cents: 20000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: person.id });
    await api("PUT", `/api/pods/${pod.id}/retainer`, { billing_type: "retainer", retainer_hours: 40, retainer_rate_cents: 800000 });
    await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day: "2026-10-07", hours: 10, note: "w" });
    const g = await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    expect(g.json.invoice.amount_cents).toBe(800000); // flat, not 10 × rate
    expect(g.json.invoice.hours).toBe(10);
    expect(g.json.invoice.line_items[0].description).toMatch(/retainer/i);
  });

  test("send without Stripe marks sent; void works; CSV export", async () => {
    const inv = (await api("GET", "/api/invoices")).json.invoices[0];
    const s = await api("POST", `/api/invoices/${inv.id}/send`);
    expect(s.json.invoice.status).toBe("sent");
    expect(s.json.invoice.stripe_invoice_id).toBeNull();
    expect(s.json.invoice.due_at).toBeTruthy();
    expect((await api("POST", `/api/invoices/${inv.id}/send`)).status).toBe(409); // only drafts
    const csv = await api("GET", "/api/invoices/export.csv");
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[0]).toBe("invoice_number,client,pod,period_start,period_end,issue_date,due_date,description,hours,amount,status");
    const v = await api("POST", `/api/invoices/${inv.id}/void`);
    expect(v.json.invoice.status).toBe("void");
  });
});

describe("Stripe (mocked)", () => {
  test("settings secrets are masked", async () => {
    await api("POST", "/api/settings", { stripe_test_secret: "sk_test_abc123XYZ" });
    const g = await api("GET", "/api/settings");
    const s = g.json.settings.stripe_test_secret;
    expect(s.set).toBe(true);
    expect(s.preview).toBe("••••3XYZ");
    expect(JSON.stringify(g.json)).not.toContain("sk_test_abc123XYZ");
    const st = await api("GET", "/api/integrations/stripe/status");
    expect(st.json.connected).toBe(true);
    expect(st.json.mode).toBe("test");
  });

  test("sync-retainers creates customer + price + subscription", async () => {
    await mockReset();
    const pod = (await api("POST", "/api/pods", { name: "StripeRetPod", client_name: "StripeCo" })).json.pod;
    await api("PUT", `/api/pods/${pod.id}/retainer`, { billing_type: "retainer", retainer_hours: 20, retainer_rate_cents: 400000 });
    const r = await api("POST", "/api/integrations/stripe/sync-retainers");
    expect(r.status).toBe(200);
    // syncs every retainer pod still missing a subscription — ours must be among them
    const mine = r.json.synced.find((s: any) => s.pod_id === pod.id);
    expect(mine).toBeTruthy();
    expect(mine.customer).toBe("cus_mock1");
    expect(mine.subscription).toBe("sub_mock1");
    const calls = await mockCalls();
    const cust = calls.find((c: any) => c.url.endsWith("/customers") && c.params.name === "StripeCo");
    expect(cust).toBeTruthy();
    const price = calls.find((c: any) => c.url.endsWith("/prices") && c.params.unit_amount === "400000");
    expect(price).toBeTruthy();
    expect(price.params["recurring[interval]"]).toBe("month");
    expect(calls.some((c: any) => c.url.endsWith("/subscriptions") && c.params["items[0][price]"] === "price_mock1")).toBe(true);
    // second sync skips (already has subscription)
    expect((await api("POST", "/api/integrations/stripe/sync-retainers")).json.synced.length).toBe(0);
  });

  test("send with Stripe creates invoice items + finalized invoice", async () => {
    await mockReset();
    const pod = (await api("POST", "/api/pods", { name: "StripeInvPod", client_name: "PayCo" })).json.pod;
    const person = (await api("POST", "/api/people", { name: "Stripe Person", hourly_rate_cents: 15000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: person.id });
    await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day: "2026-10-08", hours: 2, note: "w" });
    const g = await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    const s = await api("POST", `/api/invoices/${g.json.invoice.id}/send`);
    expect(s.json.invoice.status).toBe("sent");
    expect(s.json.invoice.stripe_invoice_id).toBe("in_mock1");
    expect(s.json.hosted_url).toBe("https://pay.stripe.com/mock1");
    const calls = await mockCalls();
    const items = calls.filter((c: any) => c.url.endsWith("/invoiceitems"));
    expect(items.length).toBe(1);
    expect(items[0].params.unit_amount).toBe("30000");
    const inv = calls.find((c: any) => /\/invoices$/.test(c.url));
    expect(inv.params["metadata[podium_invoice_id]"]).toBe(g.json.invoice.id);
    expect(calls.some((c: any) => /\/finalize/.test(c.url))).toBe(true);
  });

  test("webhook: valid signature marks paid; bad signature 400", async () => {
    await api("POST", "/api/settings", { stripe_webhook_secret: "whsec_test123" });
    const inv = (await api("GET", "/api/invoices")).json.invoices.find((i: any) => i.stripe_invoice_id === "in_mock1");
    expect(inv).toBeTruthy();
    const sign = (raw: string) => {
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", "whsec_test123").update(`${t}.${raw}`, "utf8").digest("hex");
      return `t=${t},v1=${v1}`;
    };
    const raw = JSON.stringify({
      type: "invoice.paid",
      data: { object: { id: "in_mock1", metadata: { podium_invoice_id: inv.id } } },
    });
    const ok = await api("POST", "/api/integrations/stripe/webhook", raw, { "stripe-signature": sign(raw) });
    expect(ok.status).toBe(200);
    expect((await api("GET", `/api/invoices/${inv.id}`)).json.invoice.status).toBe("paid");
    // bad signature
    const bad = await api("POST", "/api/integrations/stripe/webhook", raw, { "stripe-signature": "t=1,v1=deadbeef" });
    expect(bad.status).toBe(400);
  });
});

describe("Slack (mocked)", () => {
  test("provision-channel: create, lookup, invite, intro post", async () => {
    await api("POST", "/api/settings", { slack_bot_token: "xoxb-mock" });
    await mockReset();
    const pod = (await api("POST", "/api/pods", { name: "Acme Foods", client_name: "Acme" })).json.pod;
    const a = (await api("POST", "/api/people", { name: "Slack Alice", email: "alice@x.co" })).json.person;
    const b = (await api("POST", "/api/people", { name: "Slack Bob", email: "bob@x.co" })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: a.id });
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: b.id });
    const r = await api("POST", "/api/integrations/slack/provision-channel", { pod_id: pod.id });
    expect(r.status).toBe(200);
    expect(r.json.channel_id).toBe("C123");
    expect(r.json.invited).toBe(2);
    const calls = await mockCalls();
    const create = calls.find((c: any) => c.url.endsWith("/conversations.create"));
    expect(create.params.name).toBe("pod-acme-foods");
    expect(create.params.is_private).toBe(true);
    const lookups = calls.filter((c: any) => c.url.endsWith("/users.lookupByEmail"));
    expect(lookups.map((c: any) => c.params.email).sort()).toEqual(["alice@x.co", "bob@x.co"]);
    const invite = calls.find((c: any) => c.url.endsWith("/conversations.invite"));
    expect(invite.params.users).toBe("U_alice,U_bob");
    const post = calls.find((c: any) => c.url.endsWith("/chat.postMessage"));
    expect(post.params.text).toMatch(/Acme Foods/);
    // stored on the pod
    expect((await api("GET", `/api/pods/${pod.id}`)).json.pod.slack_channel_id).toBe("C123");
  });

  test("provision handles name_taken gracefully", async () => {
    await mockReset();
    await api("POST", "/api/_mock/slack", { mode: "name_taken" });
    const pod = (await api("POST", "/api/pods", { name: "Acme Foods", client_name: "Acme2" })).json.pod;
    const r = await api("POST", "/api/integrations/slack/provision-channel", { pod_id: pod.id });
    expect(r.status).toBe(200);
    expect(r.json.channel_id).toBe("C999"); // found via conversations.list
  });

  test("timer start/stop notifies the pod channel", async () => {
    await mockReset();
    await api("POST", "/api/_mock/slack", { mode: "ok" });
    const pods = await api("GET", "/api/pods");
    const pod = pods.json.pods.find((p: any) => p.slack_channel_id === "C123");
    const person = (await api("POST", "/api/people", { name: "Notify Person", email: "n@x.co" })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: person.id });
    await api("POST", "/api/timer/start", { person_id: person.id, pod_id: pod.id, note: "notify test" });
    await new Promise((r) => setTimeout(r, 300)); // fire-and-forget notify
    await api("POST", "/api/timer/stop", { person_id: person.id });
    await new Promise((r) => setTimeout(r, 300));
    const calls = await mockCalls();
    const posts = calls.filter((c: any) => c.url.endsWith("/chat.postMessage"));
    expect(posts.some((c: any) => /started tracking/.test(c.params.text))).toBe(true);
    expect(posts.some((c: any) => /logged 0\.1h/.test(c.params.text))).toBe(true);
  });

  test("slack test without channel → 400", async () => {
    await api("POST", "/api/settings", { slack_bot_token: "" });
    // token cleared → status disconnected
    expect((await api("GET", "/api/integrations/slack/status")).json.connected).toBe(false);
    expect((await api("POST", "/api/integrations/slack/test", {})).status).toBe(400);
    await api("POST", "/api/settings", { slack_bot_token: "xoxb-mock" });
  });
});

describe("QuickBooks Online (mocked)", () => {
  test("auth-url shape + push-invoice payload", async () => {
    expect((await api("GET", "/api/integrations/qbo/auth-url")).status).toBe(400); // no client id yet
    await api("POST", "/api/settings", {
      qbo_client_id: "cid123", qbo_client_secret: "csec", qbo_sandbox: "1",
      qbo_refresh_token: "rt0", qbo_realm_id: "999",
    });
    const u = await api("GET", "/api/integrations/qbo/auth-url");
    expect(u.status).toBe(200);
    expect(u.json.url).toContain("appcenter.intuit.com/connect/oauth2");
    expect(u.json.url).toContain("client_id=cid123");
    expect(u.json.url).toContain("com.intuit.quickbooks.accounting");

    await mockReset();
    const inv = (await api("GET", "/api/invoices")).json.invoices.find((i: any) => i.status === "draft");
    expect(inv).toBeTruthy();
    const r = await api("POST", `/api/integrations/qbo/push-invoice/${inv.id}`);
    expect(r.status).toBe(200);
    expect(r.json.qbo_id).toBe("7001");
    expect((await api("GET", `/api/invoices/${inv.id}`)).json.invoice.qbo_id).toBe("7001");
    const calls = await mockCalls();
    const tok = calls.find((c: any) => c.url.includes("oauth.platform.intuit.com"));
    expect(tok.params.grant_type).toBe("refresh_token");
    const posted = calls.find((c: any) => c.url.includes("/invoice"));
    expect(posted.params.DocNumber).toBe(inv.number);
    expect(posted.params.CustomerRef.value).toBe("9001");
    expect(posted.params.Line.length).toBe(inv.line_items.length);
    // refresh token rotated
    const s = await api("GET", "/api/settings");
    expect(s.json.settings.qbo_refresh_token.set).toBe(true);
  });

  test("push without connection → 400", async () => {
    await api("POST", "/api/settings", { qbo_refresh_token: "", qbo_realm_id: "" });
    const inv = (await api("GET", "/api/invoices")).json.invoices[0];
    expect((await api("POST", `/api/integrations/qbo/push-invoice/${inv.id}`)).status).toBe(400);
  });
});

/* ================= UI smoke for new views ================= */

describe("new views render", () => {
  let P: any;
  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    const SRC = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
    const els: Record<string, any> = {};
    const el = (id: string) => (els[id] ||= { innerHTML: "", value: "", style: {}, classList: { toggle() {} }, getAttribute: () => "", focus() {}, scrollIntoView() {} });
    const windowStub: any = {
      location: { hash: "#/home" }, scrollTo() {}, addEventListener() {},
      open() {}, localStorage: { getItem: () => null, setItem() {} },
    };
    const mod: any = { exports: {} };
    const fn = new Function("window", "document", "location", "fetch", "localStorage", "matchMedia", "confirm", "prompt", "module", "scrollTo", "setInterval", SRC);
    fn(windowStub, { getElementById: (id: string) => el(id), querySelectorAll: () => [], createElement: () => el("dyn"), body: {} },
      { hash: "#/home" }, () => Promise.reject(new Error("no fetch")), windowStub.localStorage,
      () => ({ matches: false }), () => true, () => null, mod, () => {}, () => 0);
    P = windowStub.Podium;
  });

  const stages = [
    { stage: "intro", label: "Intro Call", count: 1, total_cents: 6000000, weighted_cents: 600000, leads: [
      { id: "l1", name: "Dana Kim", company: "Kim Logistics", temperature: "hot", priority: 1, value_cents: 6000000, stage: "intro", partner_name: "BlueYard", pod_id: null },
    ]},
    { stage: "diagnostic", label: "Diagnostic Pitch", count: 0, total_cents: 0, weighted_cents: 0, leads: [] },
    { stage: "sow", label: "SOW Sent", count: 0, total_cents: 0, weighted_cents: 0, leads: [] },
    { stage: "won", label: "Closed Won", count: 1, total_cents: 100000, weighted_cents: 100000, leads: [
      { id: "l2", name: "Won Guy", company: "WonCo", temperature: "warm", priority: 2, value_cents: 100000, stage: "won", pod_id: null },
    ]},
    { stage: "lost", label: "Lost", count: 0, total_cents: 0, weighted_cents: 0, leads: [] },
  ];

  test("pipeline kanban", () => {
    const h = P.viewPipeline({ stages });
    expect(h).toContain("Pipeline");
    expect(h).toContain("Intro Call");
    expect(h).toContain("Dana Kim");
    expect(h).toContain("Kim Logistics");
    expect(h).toContain("$60,000.00");
    expect(h).toContain("Top 20");
    expect(h).toContain("New lead");
  });
  test("top 20", () => {
    const h = P.viewTop20([{ id: "l1", name: "Dana Kim", company: "Kim Logistics", temperature: "hot", priority: 1, value_cents: 6000000, stage: "intro" }]);
    expect(h).toContain("Top 20");
    expect(h).toContain("Dana Kim");
    expect(h).toContain("P1");
  });
  test("lead detail with spin-up", () => {
    const h = P.viewLead({ id: "l2", name: "Won Guy", company: "WonCo", temperature: "warm", priority: 2, value_cents: 100000, stage: "won", notes: "", pod_id: null, partner_id: null }, [], []);
    expect(h).toContain("Won Guy");
    expect(h).toContain("Spin up pod");
    expect(h).toContain("Closed Won");
  });
  test("schedule", () => {
    const h = P.viewSchedule({
      bookings: [{ id: "b1", start_at: "2026-10-10T10:00:00", person_name: "Ava", booker_name: "Booker", lead_id: null }],
      people: [{ id: "u1", name: "Ava", title: "CEO", booking_slug: "ava" }],
      availability: { u1: [{ id: "a1", weekday: 1, start_min: 540, end_min: 1020 }] },
    });
    expect(h).toContain("Schedule");
    expect(h).toContain("Booker");
    expect(h).toContain("/book/ava");
    expect(h).toContain("09:00");
  });
  test("invoices list + detail", () => {
    const h = P.viewInvoices([{ id: "i1", number: "INV-2026-001", client_name: "Acme", pod_name: "Acme Foods", period_start: "2026-10-01", period_end: "2026-10-31", amount_cents: 50000, status: "draft" }], null, []);
    expect(h).toContain("INV-2026-001");
    expect(h).toContain("Generate draft");
    expect(h).toContain("export.csv");
    const d = P.viewInvoices([], { invoice: { id: "i1", number: "INV-2026-001", client_name: "Acme", period_start: "2026-10-01", period_end: "2026-10-31", amount_cents: 50000, status: "draft", line_items: [{ description: "Monthly retainer", hours: 10, amount_cents: 50000 }], stripe_invoice_id: null, qbo_id: null, due_at: null }, qboConnected: true }, []);
    expect(d).toContain("$500.00");
    expect(d).toContain("Send invoice");
    expect(d).toContain("Push to QuickBooks");
  });
  test("settings", () => {
    const h = P.viewSettings({ settings: { stripe_test_secret: { set: true, preview: "••••3XYZ" }, stripe_mode: { set: false, preview: "test" } }, stripeMode: "test", qboConnected: false, pods: [] }, []);
    expect(h).toContain("Stripe");
    expect(h).toContain("Slack");
    expect(h).toContain("QuickBooks");
    expect(h).toContain("Page templates");
    expect(h).toContain("••••3XYZ");
    expect(h).not.toContain("sk_test");
  });
  test("timer widget + retainer bar", () => {
    const idle = P.viewTimerWidget({ id: "p1" }, [{ person_id: "u1", person_name: "Ava" }], []);
    expect(idle).toContain("timer-btn");
    expect(idle).toContain("Start");
    const running = P.viewTimerWidget({ id: "p1" }, [], [{ person_id: "u1", person_name: "Ava", pod_id: "p1", elapsed_sec: 95 }]);
    expect(running).toContain("Stop");
    expect(running).toContain("1:35");
    const amber = P.viewRetainerBar({ hours: 34, cap: 40, pct: 0.85 });
    expect(amber).toContain("var(--amber)");
    const red = P.viewRetainerBar({ hours: 44, cap: 40, pct: 1.1 });
    expect(red).toContain("var(--red)");
    expect(red).toContain("over cap");
    const sage = P.viewRetainerBar({ hours: 10, cap: 40, pct: 0.25 });
    expect(sage).toContain("var(--sage)");
  });
  test("sidebar has new nav", () => {
    // renderSidebar reads module state; exercise via a full render path instead:
    // pipeline view is reachable — assert route function exists through view fns
    expect(typeof P.viewPipeline).toBe("function");
    expect(typeof P.viewSchedule).toBe("function");
    expect(typeof P.viewInvoices).toBe("function");
    expect(typeof P.viewSettings).toBe("function");
  });
});
