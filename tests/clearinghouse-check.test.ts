// Podium phase 3: billing clearinghouse & automated distribution tests.
// Pure split-math via direct db import; API + webhook + scheduler via a child
// server with PODIUM_MOCK_INTEGRATIONS=1 (no real network calls).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

process.env.PODIUM_DATA = mkdtempSync(join(tmpdir(), "podium-ch-unit-"));
const db = await import("../src/db.ts");
db.initDb();

const DATA = mkdtempSync(join(tmpdir(), "podium-ch-"));
const PORT = "32203";
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
  try { j = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, json: j, text };
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
  throw new Error("clearinghouse test server did not start");
});
afterAll(() => { try { proc.kill(); } catch {} });

async function mockReset() { await api("POST", "/api/_mock/reset"); }
async function mockCalls(): Promise<any[]> { return (await api("GET", "/api/_mock/calls")).json.calls; }

/* ================= split math (pure) ================= */

function setupSplitFixture(rate = 100000) {
  const a = db.createPerson({ name: "Split A", hourly_rate_cents: rate });
  const b = db.createPerson({ name: "Split B", hourly_rate_cents: rate });
  const pod = db.createPod({ name: "Split Pod", client_name: "SplitCo" });
  db.addMember(pod.id, a.id, "");
  db.addMember(pod.id, b.id, "");
  return { a, b, pod };
}

describe("split math", () => {
  test("60/40 hours on $10,000 at 20% spread — exact cents", () => {
    const { a, b, pod } = setupSplitFixture();
    db.createEntry({ person_id: a.id, pod_id: pod.id, day: "2026-10-05", hours: 6, billable: 1 });
    db.createEntry({ person_id: b.id, pod_id: pod.id, day: "2026-10-06", hours: 4, billable: 1 });
    const inv = db.generateInvoice({ pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    expect(inv.amount_cents).toBe(1000000); // 10h × $1,000/hr = $10,000
    db.setSetting("platform_spread_pct", "20");
    const shares = db.computeSplit(inv.id);
    const sa = shares.find((s) => s.person_id === a.id)!;
    const sb = shares.find((s) => s.person_id === b.id)!;
    expect(sa.gross_cents).toBe(600000);
    expect(sa.spread_cents).toBe(120000);
    expect(sa.net_cents).toBe(480000);
    expect(sb.gross_cents).toBe(400000);
    expect(sb.spread_cents).toBe(80000);
    expect(sb.net_cents).toBe(320000);
    // Σ checks out exactly
    expect(shares.reduce((x, s) => x + s.gross_cents, 0)).toBe(1000000);
    expect(shares.reduce((x, s) => x + s.spread_cents + s.net_cents, 0)).toBe(1000000);
  });

  test("zero hours → even split among members", () => {
    const { a, b, pod } = setupSplitFixture();
    // retainer pod: flat amount, no time logged
    db.updatePodBilling(pod.id, { billing_type: "retainer", retainer_rate_cents: 500000 });
    const inv = db.generateInvoice({ pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    expect(inv.amount_cents).toBe(500000);
    const shares = db.computeSplit(inv.id, 20);
    expect(shares.length).toBe(2);
    expect(shares[0].gross_cents).toBe(250000);
    expect(shares[1].gross_cents).toBe(250000);
    expect(shares.reduce((x, s) => x + s.net_cents, 0)).toBe(400000);
  });

  test("rounding remainder: 3 execs split $100.00 at 20%", () => {
    const p1 = db.createPerson({ name: "R1", hourly_rate_cents: 10000 });
    const p2 = db.createPerson({ name: "R2", hourly_rate_cents: 10000 });
    const p3 = db.createPerson({ name: "R3", hourly_rate_cents: 10000 });
    const pod = db.createPod({ name: "Round Pod", client_name: "RC" });
    for (const p of [p1, p2, p3]) db.addMember(pod.id, p.id, "");
    // craft a $100 invoice directly via entries: 1h each at $100 = $300... instead use retainer
    db.updatePodBilling(pod.id, { billing_type: "retainer", retainer_rate_cents: 10000 });
    const inv = db.generateInvoice({ pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" });
    const shares = db.computeSplit(inv.id, 20);
    // 10000/3 = 3333.33 → largest remainder: one gets 3334, two get 3333
    const grosses = shares.map((s) => s.gross_cents).sort((x, y) => y - x);
    expect(grosses).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((x, s) => x + s.gross_cents, 0)).toBe(10000);
    expect(shares.reduce((x, s) => x + s.spread_cents + s.net_cents, 0)).toBe(10000);
  });

  test("platformSpreadPct defaults + clamps", () => {
    db.setSetting("platform_spread_pct", "");
    expect(db.platformSpreadPct()).toBe(20);
    db.setSetting("platform_spread_pct", "25");
    expect(db.platformSpreadPct()).toBe(25);
    db.setSetting("platform_spread_pct", "999");
    expect(db.platformSpreadPct()).toBe(20); // clamped
    db.setSetting("platform_spread_pct", "20");
  });

  test("monthBounds validates", () => {
    expect(db.monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(db.monthBounds("2024-02").end).toBe("2024-02-29"); // leap year
    expect(() => db.monthBounds("2026-13")).toThrow();
    expect(() => db.monthBounds("nope")).toThrow();
  });
});

/* ================= API: distribute ================= */

describe("distribute API", () => {
  let podId: string; let aliceId: string; let bobId: string; let invId: string;

  test("setup: pod + entries + invoice", async () => {
    const alice = (await api("POST", "/api/people", { name: "Pay Alice", hourly_rate_cents: 20000 })).json.person;
    const bob = (await api("POST", "/api/people", { name: "Pay Bob", hourly_rate_cents: 20000 })).json.person;
    aliceId = alice.id; bobId = bob.id;
    const pod = (await api("POST", "/api/pods", { name: "PayPod", client_name: "PayCo" })).json.pod;
    podId = pod.id;
    await api("POST", `/api/pods/${podId}/members`, { person_id: aliceId });
    await api("POST", `/api/pods/${podId}/members`, { person_id: bobId });
    await api("POST", "/api/time", { person_id: aliceId, pod_id: podId, day: "2026-10-05", hours: 3, billable: 1 });
    await api("POST", "/api/time", { person_id: bobId, pod_id: podId, day: "2026-10-06", hours: 1, billable: 1 });
    const inv = (await api("POST", "/api/invoices/generate", { pod_id: podId, period_start: "2026-10-01", period_end: "2026-10-31" })).json.invoice;
    invId = inv.id;
    expect(inv.amount_cents).toBe(80000); // 4h × $200
  });

  test("distribute on unpaid invoice → 409", async () => {
    const r = await api("POST", `/api/invoices/${invId}/distribute`);
    expect(r.status).toBe(409);
  });

  test("webhook invoice.paid → auto-distribution in dry-run mode", async () => {
    await api("POST", "/api/settings", { stripe_webhook_secret: "whsec_ch1", stripe_test_secret: "sk_test_x" });
    // send via mocked Stripe so the invoice has a stripe id
    const sent = await api("POST", `/api/invoices/${invId}/send`);
    expect(sent.status).toBe(200);
    const stripeId = sent.json.invoice.stripe_invoice_id;
    expect(stripeId).toBeTruthy();
    const raw = JSON.stringify({ type: "invoice.paid", data: { object: { id: stripeId, metadata: { podium_invoice_id: invId } } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_ch1").update(`${t}.${raw}`, "utf8").digest("hex");
    const wh = await api("POST", "/api/integrations/stripe/webhook", raw, { "stripe-signature": `t=${t},v1=${v1}` });
    expect(wh.status).toBe(200);
    // distribution auto-created, dry-run (payouts_live not armed)
    const d = await api("GET", `/api/invoices/${invId}/distribution`);
    expect(d.status).toBe(200);
    expect(d.json.distribution.mode).toBe("dry_run");
    expect(d.json.payouts.length).toBe(2);
    const alice = d.json.payouts.find((p: any) => p.person_id === aliceId);
    expect(alice.gross_cents).toBe(60000); // 3h/4h of $800
    expect(alice.spread_cents).toBe(12000);
    expect(alice.net_cents).toBe(48000);
    expect(alice.status).toBe("pending");
    // dry run: NO stripe transfers called
    const transfers = (await mockCalls()).filter((c: any) => c.url.endsWith("/transfers"));
    expect(transfers.length).toBe(0);
  });

  test("double-distribute → 409", async () => {
    const r = await api("POST", `/api/invoices/${invId}/distribute`);
    expect(r.status).toBe(409);
  });

  test("payouts ledger API", async () => {
    const all = await api("GET", "/api/payouts");
    expect(all.status).toBe(200);
    expect(all.json.payouts.length).toBeGreaterThanOrEqual(2);
    const mine = await api("GET", `/api/payouts?person_id=${aliceId}`);
    expect(mine.json.payouts.every((p: any) => p.person_id === aliceId)).toBe(true);
    const pend = await api("GET", "/api/payouts?status=pending");
    expect(pend.json.payouts.every((p: any) => p.status === "pending")).toBe(true);
  });

  test("stripe_connect_id editable + shown on person", async () => {
    const u = await api("PUT", `/api/people/${aliceId}`, { stripe_connect_id: "acct_test123" });
    expect(u.status).toBe(200);
    expect(u.json.person.stripe_connect_id).toBe("acct_test123");
  });
});

/* ================= live-mode gate ================= */

describe("live payout gating", () => {
  test("transfers fire only when armed AND connected", async () => {
    // fresh invoice for the live test
    const carol = (await api("POST", "/api/people", { name: "Live Carol", hourly_rate_cents: 10000, stripe_connect_id: "acct_carol1" })).json.person;
    const pod = (await api("POST", "/api/pods", { name: "LivePod", client_name: "LiveCo" })).json.pod;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: carol.id });
    await api("POST", "/api/time", { person_id: carol.id, pod_id: pod.id, day: "2026-10-05", hours: 2, billable: 1 });
    const inv = (await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" })).json.invoice;
    await api("POST", `/api/invoices/${inv.id}/send`);
    // mark paid directly via webhook-less path: use the API's paid transition through a second webhook
    const inv2 = (await api("GET", `/api/invoices/${inv.id}`)).json.invoice;
    const raw = JSON.stringify({ type: "invoice.paid", data: { object: { id: inv2.stripe_invoice_id, metadata: { podium_invoice_id: inv.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_ch1").update(`${t}.${raw}`, "utf8").digest("hex");
    // arm live payouts
    await api("POST", "/api/settings", { payouts_live: "1" });
    await mockReset();
    await api("POST", "/api/integrations/stripe/webhook", raw, { "stripe-signature": `t=${t},v1=${v1}` });
    const d = await api("GET", `/api/invoices/${inv.id}/distribution`);
    expect(d.json.distribution.mode).toBe("live");
    const transfers = (await mockCalls()).filter((c: any) => c.url.endsWith("/transfers"));
    expect(transfers.length).toBe(1);
    expect(transfers[0].params.destination).toBe("acct_carol1");
    expect(transfers[0].params.amount).toBe(String(d.json.payouts[0].net_cents));
    const paid = d.json.payouts[0];
    expect(paid.status).toBe("paid");
    expect(paid.stripe_transfer_id).toBe("tr_mock1");
    // disarm for other tests
    await api("POST", "/api/settings", { payouts_live: "0" });
  });

  test("live mode without connect id → payout failed, others proceed", async () => {
    const d1 = (await api("POST", "/api/people", { name: "NoAcct Dan", hourly_rate_cents: 10000 })).json.person;
    const e1 = (await api("POST", "/api/people", { name: "HasAcct Erin", hourly_rate_cents: 10000, stripe_connect_id: "acct_erin1" })).json.person;
    const pod = (await api("POST", "/api/pods", { name: "MixedPod", client_name: "MixCo" })).json.pod;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: d1.id });
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: e1.id });
    await api("POST", "/api/time", { person_id: d1.id, pod_id: pod.id, day: "2026-10-05", hours: 1, billable: 1 });
    await api("POST", "/api/time", { person_id: e1.id, pod_id: pod.id, day: "2026-10-05", hours: 1, billable: 1 });
    const inv = (await api("POST", "/api/invoices/generate", { pod_id: pod.id, period_start: "2026-10-01", period_end: "2026-10-31" })).json.invoice;
    await api("POST", `/api/invoices/${inv.id}/send`);
    const inv2 = (await api("GET", `/api/invoices/${inv.id}`)).json.invoice;
    const raw = JSON.stringify({ type: "invoice.paid", data: { object: { id: inv2.stripe_invoice_id, metadata: { podium_invoice_id: inv.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_ch1").update(`${t}.${raw}`, "utf8").digest("hex");
    await api("POST", "/api/settings", { payouts_live: "1" });
    await api("POST", "/api/integrations/stripe/webhook", raw, { "stripe-signature": `t=${t},v1=${v1}` });
    const d = await api("GET", `/api/invoices/${inv.id}/distribution`);
    const dan = d.json.payouts.find((p: any) => p.person_id === d1.id);
    const erin = d.json.payouts.find((p: any) => p.person_id === e1.id);
    expect(dan.status).toBe("failed");
    expect(dan.failure).toMatch(/no Stripe Connect/i);
    expect(erin.status).toBe("paid");
    await api("POST", "/api/settings", { payouts_live: "0" });
  });
});

/* ================= billing runs ================= */

describe("1st-of-month billing runs", () => {
  test("manual run: retainer pod invoiced, subscription pod skipped, idempotent", async () => {
    // SubPod first: give it a subscription via sync-retainers, THEN create BillPod
    // so BillPod has no subscription (sync only touches subscription-less pods).
    const sub = (await api("POST", "/api/pods", { name: "SubPod", client_name: "SubCo" })).json.pod;
    await api("PUT", `/api/pods/${sub.id}/retainer`, { billing_type: "retainer", retainer_hours: 10, retainer_rate_cents: 200000 });
    await api("POST", "/api/settings", { stripe_test_secret: "sk_test_x" });
    const synced = await api("POST", "/api/integrations/stripe/sync-retainers");
    expect(synced.status).toBe(200);
    expect(synced.json.synced.some((s: any) => s.pod_id === sub.id)).toBe(true);
    const pod = (await api("POST", "/api/pods", { name: "BillPod", client_name: "BillCo" })).json.pod;
    await api("PUT", `/api/pods/${pod.id}/retainer`, { billing_type: "retainer", retainer_hours: 20, retainer_rate_cents: 400000 });
    const run1 = await api("POST", "/api/billing/run", { month: "2026-11" });
    expect(run1.status).toBe(200);
    const items = run1.json.items;
    const billItem = items.find((i: any) => i.pod_id === pod.id);
    const subItem = items.find((i: any) => i.pod_id === sub.id);
    expect(billItem.via).toBe("invoice");
    expect(billItem.number).toMatch(/^INV-/);
    expect(subItem.via).toBe("subscription");
    expect(subItem.invoice_id).toBeNull();
    // idempotent: second run refused
    const run2 = await api("POST", "/api/billing/run", { month: "2026-11" });
    expect(run2.status).toBe(409);
    // force re-runs
    const run3 = await api("POST", "/api/billing/run", { month: "2026-11", force: true });
    expect(run3.status).toBe(200);
    // history lists the month once
    const runs = await api("GET", "/api/billing/runs");
    expect(runs.json.runs.filter((r: any) => r.run_month === "2026-11").length).toBe(1);
  });

  test("bad month rejected", async () => {
    const r = await api("POST", "/api/billing/run", { month: "whenever" });
    expect(r.status).toBe(400);
  });
});

/* ================= scheduler boot check ================= */

describe("scheduler", () => {
  test("child booted on the 1st auto-runs billing", async () => {
    const data2 = mkdtempSync(join(tmpdir(), "podium-ch-sched-"));
    const port2 = "32204";
    const base2 = "http://127.0.0.1:" + port2;
    const p2 = Bun.spawn(["bun", SERVER], {
      env: { ...process.env, PODIUM_DATA: data2, PORT: port2, PODIUM_MOCK_INTEGRATIONS: "1", PODIUM_TODAY: "2026-11-01T10:00:00" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(base2 + "/api/status"); if (r.ok) break; } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      // seeded pods are hourly → run records with zero items but the month is marked
      const runs = await (await fetch(base2 + "/api/billing/runs")).json();
      expect(runs.runs.some((r: any) => r.run_month === "2026-11")).toBe(true);
    } finally {
      try { p2.kill(); } catch {}
    }
  });
});

/* ================= UI render smoke ================= */

describe("clearinghouse UI", () => {
  test("new views render without throwing", async () => {
    const { default: fs } = await import("node:fs");
    const SRC = fs.readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
    const els: Record<string, any> = {};
    const el = (id: string) => (els[id] ||= { innerHTML: "", value: "", style: {}, classList: { toggle() {} }, getAttribute: () => "", focus() {}, scrollIntoView() {} });
    const documentStub: any = {
      getElementById: (id: string) => el(id),
      querySelectorAll: () => [],
      createElement: () => el("dyn"),
      body: { innerText: "" },
    };
    const windowStub: any = { location: { hash: "#/home" }, scrollTo() {}, addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } };
    const fn = new Function(
      "window", "document", "location", "fetch", "localStorage", "matchMedia", "confirm", "prompt", "module", "scrollTo", SRC
    );
    fn(windowStub, documentStub, { hash: "#/home" },
      () => Promise.reject(new Error("no fetch")), windowStub.localStorage,
      () => ({ matches: false }), () => true, () => null, {}, () => {});
    const Podium = windowStub.Podium as any;
    expect(Podium).toBeTruthy();
    const dist = {
      distribution: { mode: "dry_run", spread_pct: 20, ran_at: "2026-10-08T10:00:00Z" },
      payouts: [
        { person_id: "a", person_name: "Alice", gross_cents: 60000, spread_cents: 12000, net_cents: 48000, status: "pending", stripe_transfer_id: null, failure: "" },
        { person_id: "b", person_name: "Bob", gross_cents: 40000, spread_cents: 8000, net_cents: 32000, status: "paid", stripe_transfer_id: "tr_1", failure: "" },
      ],
    };
    const h1 = Podium.viewDistribution(dist, { id: "i1", status: "paid" });
    expect(h1).toContain("DRY RUN");
    expect(h1).toContain("Alice");
    expect(h1).toContain("tr_1");
    const h2 = Podium.viewDistribution(null, { id: "i1", status: "paid" });
    expect(h2).toContain("Distribute to execs");
    const h3 = Podium.viewDistribution(null, { id: "i1", status: "sent" });
    expect(h3).toContain("unlocks when the invoice is paid");
    const h4 = Podium.viewBillingRuns([{ run_month: "2026-11", ran_at: "2026-11-01T00:00:00Z", items: [{ pod_name: "P", via: "invoice", number: "INV-2026-001" }] }]);
    expect(h4).toContain("2026-11");
    expect(h4).toContain("INV-2026-001");
    const h5 = Podium.viewPayoutLedger(dist.payouts.map((p: any) => ({ ...p, invoice_number: "INV-1" })));
    expect(h5).toContain("Alice");
  });
});
