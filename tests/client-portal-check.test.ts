// Podium phase 2: client portal & value-log engine tests.
// - public intake form → lead (validation, rate limit, pipeline visibility)
// - objectives & key results CRUD + validation + cascade delete
// - value-log: block_type + decisions on entries, timer stop, editing
// - scope-drift alerts: 80%/100% crossing, dedupe, monthly, mark-seen, Slack (mocked)
// - SOW e-signing: ceremony, hash verification, token entropy, revoke, double-sign
// - public pages served (/intake, /sign/:token)
// - UI renders (DOM-stubbed app.js) + CSS checks
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DATA = mkdtempSync(join(tmpdir(), "podium-portal-"));
const PORT = "32331";
const BASE = "http://127.0.0.1:" + PORT;
const SERVER = new URL("../src/server.ts", import.meta.url).pathname;

async function api(method: string, path: string, body?: any) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  throw new Error("test server did not start");
});
afterAll(() => { try { proc.kill(); } catch {} });

async function mkPerson(name: string) {
  const r = await api("POST", "/api/people", { name, title: "Fractional CFO", hourly_rate_cents: 20000 });
  expect(r.status).toBe(201);
  return r.json.person;
}
async function mkPod(name: string) {
  const r = await api("POST", "/api/pods", { name, client_name: name + " Inc", color: "#c96f4a" });
  expect(r.status).toBe(201);
  return r.json.pod;
}
async function mkRetainerPod(name: string, capHours: number) {
  const pod = await mkPod(name);
  const r = await api("PUT", "/api/pods/" + pod.id + "/retainer", {
    billing_type: "retainer", retainer_hours: capHours, retainer_rate_cents: 500000,
  });
  expect(r.status).toBe(200);
  return { ...pod, ...r.json.pod };
}

describe("public intake → lead", () => {
  test("valid submission creates an intro-stage lead with source=intake", async () => {
    const r = await api("POST", "/api/intake", {
      name: "Jane Founder", company: "Acme Foods", email: "jane@acme.com",
      phone: "+1 555 010 2030", needs: "Need a fractional CFO for our Series A.",
      budget_band: "$5–10k/mo", contact_method: "Email",
    });
    expect(r.status).toBe(201);
    const lead = r.json.lead;
    expect(lead.stage).toBe("intro");
    expect(lead.source).toBe("intake");
    expect(lead.name).toBe("Jane Founder");
    expect(lead.budget_band).toBe("$5–10k/mo");
    expect(lead.contact_method).toBe("Email");
    // visible in the normal pipeline
    const pipe = await api("GET", "/api/leads");
    expect(pipe.status).toBe(200);
    expect(pipe.json.leads.some((l: any) => l.id === lead.id)).toBe(true);
  });
  test("validation: name/company/email required, email format checked", async () => {
    const bad = [
      { company: "Acme", email: "j@acme.com" },
      { name: "Jane", email: "j@acme.com" },
      { name: "Jane", company: "Acme", email: "not-an-email" },
      { name: "Jane", company: "Acme", email: "" },
    ];
    for (const b of bad) {
      const r = await api("POST", "/api/intake", b);
      expect(r.status).toBe(400);
    }
  });
  test("budget band outside the allowed set is rejected", async () => {
    const r = await api("POST", "/api/intake", {
      name: "Jane", company: "Acme", email: "j@acme.com", budget_band: "$1M/mo",
    });
    expect(r.status).toBe(400);
  });
  test("rate limit: sustained submissions eventually get 429", async () => {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) {
      const r = await api("POST", "/api/intake", {
        name: "Spam " + i, company: "SpamCo", email: "spam" + i + "@x.com",
      });
      if (r.status === 429) limited = true;
      else expect(r.status).toBe(201);
    }
    expect(limited).toBe(true);
  });
  test("GET /intake serves the standalone form", async () => {
    const r = await fetch(BASE + "/intake");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("intake-form");
    expect(html).toContain("budget_band");
  });
});

describe("objectives & key results", () => {
  let pod: any, objId: string;
  test("create + list objectives on a pod", async () => {
    pod = await mkPod("Objective Pod");
    const r = await api("POST", "/api/pods/" + pod.id + "/objectives", {
      title: "Cut monthly burn below $180k", period: "2026-Q4",
    });
    expect(r.status).toBe(201);
    objId = r.json.objective.id;
    expect(r.json.objective.progress_pct).toBe(0);
    expect(r.json.objective.status).toBe("on_track");
    const list = await api("GET", "/api/pods/" + pod.id + "/objectives");
    expect(list.json.objectives.length).toBe(1);
    expect(list.json.objectives[0].key_results).toEqual([]);
  });
  test("inline progress update + status", async () => {
    const r = await api("PUT", "/api/objectives/" + objId, { progress_pct: 60, status: "at_risk" });
    expect(r.status).toBe(200);
    expect(r.json.objective.progress_pct).toBe(60);
    expect(r.json.objective.status).toBe("at_risk");
  });
  test("invalid progress / status rejected", async () => {
    expect((await api("PUT", "/api/objectives/" + objId, { progress_pct: 101 })).status).toBe(400);
    expect((await api("PUT", "/api/objectives/" + objId, { progress_pct: -1 })).status).toBe(400);
    expect((await api("PUT", "/api/objectives/" + objId, { status: "bogus" })).status).toBe(400);
  });
  test("key result CRUD", async () => {
    const c = await api("POST", "/api/objectives/" + objId + "/key-results", {
      title: "Renegotiate distributor terms", target: "−$25k/mo", current: "−$14k/mo",
    });
    expect(c.status).toBe(201);
    const krId = c.json.key_result.id;
    const u = await api("PUT", "/api/key-results/" + krId, { current: "−$18k/mo" });
    expect(u.status).toBe(200);
    expect(u.json.key_result.current).toBe("−$18k/mo");
    const g = await api("GET", "/api/pods/" + pod.id + "/objectives");
    expect(g.json.objectives[0].key_results.length).toBe(1);
    expect((await api("DELETE", "/api/key-results/" + krId)).status).toBe(200);
    const g2 = await api("GET", "/api/pods/" + pod.id + "/objectives");
    expect(g2.json.objectives[0].key_results.length).toBe(0);
  });
  test("delete objective cascades its key results", async () => {
    await api("POST", "/api/objectives/" + objId + "/key-results", { title: "KR doomed" });
    expect((await api("DELETE", "/api/objectives/" + objId)).status).toBe(200);
    expect((await api("GET", "/api/objectives/" + objId)).status).toBe(404);
    const list = await api("GET", "/api/pods/" + pod.id + "/objectives");
    expect(list.json.objectives.length).toBe(0);
  });
  test("404s for unknown pod / objective", async () => {
    expect((await api("POST", "/api/pods/nope/objectives", { title: "x" })).status).toBe(404);
    expect((await api("POST", "/api/objectives/nope/key-results", { title: "x" })).status).toBe(404);
  });
  test("demo pods ship with a seeded example objective", async () => {
    const pods = await api("GET", "/api/pods");
    let found = 0;
    for (const p of pods.json.pods) {
      const o = await api("GET", "/api/pods/" + p.id + "/objectives");
      if (o.json.objectives.length > 0) found++;
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });
});

describe("value-log: block_type + decisions", () => {
  let person: any, pod: any, entryId: string;
  const day = "2026-10-05";
  test("entry with block_type + decisions persists", async () => {
    person = await mkPerson("Value Logger");
    pod = await mkPod("Value Pod");
    await api("POST", "/api/pods/" + pod.id + "/members", { person_id: person.id, role: "Lead" });
    const r = await api("POST", "/api/time", {
      person_id: person.id, pod_id: pod.id, day, hours: 4, note: "Board prep",
      block_type: "advisory", decisions: "Approved the pricing change\nShipped onboarding flow",
    });
    expect(r.status).toBe(201);
    entryId = r.json.entry.id;
    expect(r.json.entry.block_type).toBe("advisory");
    expect(r.json.entry.decisions).toContain("pricing change");
  });
  test("defaults: block_type=hours, decisions empty", async () => {
    const r = await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day, hours: 1 });
    expect(r.status).toBe(201);
    expect(r.json.entry.block_type).toBe("hours");
    expect(r.json.entry.decisions).toBe("");
  });
  test("invalid block_type rejected", async () => {
    const r = await api("POST", "/api/time", {
      person_id: person.id, pod_id: pod.id, day, hours: 1, block_type: "yoga",
    });
    expect(r.status).toBe(400);
  });
  test("entry editing updates block metadata", async () => {
    const r = await api("PUT", "/api/time/" + entryId, { block_type: "milestone", decisions: "Launched v2" });
    expect(r.status).toBe(200);
    expect(r.json.entry.block_type).toBe("milestone");
    expect(r.json.entry.decisions).toBe("Launched v2");
  });
  test("timer stop carries block_type + decisions", async () => {
    const s = await api("POST", "/api/timer/start", { person_id: person.id, pod_id: pod.id, note: "Deep work" });
    expect(s.status).toBe(201);
    const st = await api("POST", "/api/timer/stop", {
      person_id: person.id, block_type: "sprint", decisions: "Finished the sprint demo",
    });
    expect(st.status).toBe(200);
    expect(st.json.entry.block_type).toBe("sprint");
    expect(st.json.entry.decisions).toBe("Finished the sprint demo");
  });
});

describe("scope-drift alerts", () => {
  let person: any, pod: any;
  const day = "2026-10-06";
  async function logHours(h: number) {
    const r = await api("POST", "/api/time", { person_id: person.id, pod_id: pod.id, day, hours: h, note: "work" });
    expect(r.status).toBe(201);
    return r.json;
  }
  test("79→81% crossing creates exactly one overage_80 alert; 85% creates none", async () => {
    person = await mkPerson("Alert Tester");
    pod = await mkRetainerPod("Alert Pod", 10);
    await api("POST", "/api/pods/" + pod.id + "/members", { person_id: person.id, role: "Lead" });
    let j = await logHours(7.9);
    expect(j.alert).toBeNull();
    expect((await api("GET", "/api/alerts")).json.alerts.length).toBe(0);
    j = await logHours(0.2); // 8.1h = 81%
    expect(j.alert).not.toBeNull();
    expect(j.alert.kind).toBe("overage_80");
    expect(j.alert.message).toContain("Alert Pod");
    expect(j.alert.message).toContain("#/pod/" + pod.id + "/time");
    j = await logHours(0.4); // 8.5h = 85% — no duplicate
    expect(j.alert).toBeNull();
    const alerts = (await api("GET", "/api/alerts")).json.alerts;
    expect(alerts.filter((a: any) => a.kind === "overage_80").length).toBe(1);
  });
  test("100% crossing creates overage_100", async () => {
    const j = await logHours(1.5); // 10.0h = 100%
    expect(j.alert).not.toBeNull();
    expect(j.alert.kind).toBe("overage_100");
    const alerts = (await api("GET", "/api/alerts")).json.alerts;
    expect(alerts.filter((a: any) => a.kind === "overage_100").length).toBe(1);
  });
  test("filter unseen + mark seen", async () => {
    const all = (await api("GET", "/api/alerts")).json;
    expect(all.unseen).toBe(2);
    const unseen = (await api("GET", "/api/alerts?unseen=1")).json.alerts;
    expect(unseen.length).toBe(2);
    expect((await api("POST", "/api/alerts/" + unseen[0].id + "/seen", {})).status).toBe(200);
    const after = (await api("GET", "/api/alerts?unseen=1")).json;
    expect(after.alerts.length).toBe(1);
    expect(after.unseen).toBe(1);
  });
  test("Slack post attempted on alert when pod is connected (mocked)", async () => {
    const p2 = await mkPerson("Slack Alert Tester");
    const pod2 = await mkRetainerPod("Slack Alert Pod", 10);
    await api("POST", "/api/pods/" + pod2.id + "/members", { person_id: p2.id, role: "Lead" });
    await api("POST", "/api/settings", { slack_bot_token: "xoxb-test-token" });
    const prov = await api("POST", "/api/integrations/slack/provision-channel", { pod_id: pod2.id });
    expect(prov.status).toBe(200);
    await api("POST", "/api/_mock/reset", {});
    const tr = await api("POST", "/api/time", {
      person_id: p2.id, pod_id: pod2.id, day, hours: 8.5, note: "big week",
    });
    expect(tr.status).toBe(201);
    const j = tr.json;
    expect(j.alert).not.toBeNull();
    expect(j.alert.kind).toBe("overage_80");
    // give the fire-and-forget notify a beat, then inspect the mock log
    await new Promise((r) => setTimeout(r, 300));
    const calls = (await api("GET", "/api/_mock/calls")).json.calls;
    const slackPosts = calls.filter((c: any) => String(c.url).includes("chat.postMessage"));
    expect(slackPosts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(slackPosts[0].params)).toContain("Scope drift");
  });
});

describe("SOW e-signing", () => {
  let pod: any, page: any, token: string;
  const BODY = "# Statement of Work\n\n**Scope:** fractional CFO pod.\n\n- Monthly close\n- Board reporting";
  test("send for signature creates a token link", async () => {
    pod = await mkPod("Signing Pod");
    const pg = await api("POST", "/api/pods/" + pod.id + "/pages", { title: "SOW v1", body_md: BODY });
    expect(pg.status).toBe(201);
    page = pg.json.page;
    const r = await api("POST", "/api/pages/" + page.id + "/signing", {
      signer_name: "Client CEO", signer_email: "ceo@client.com",
    });
    expect(r.status).toBe(201);
    token = r.json.signing.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 256-bit token, hex
    expect(r.json.signing.status).toBe("pending");
  });
  test("signing page + state API (no auth)", async () => {
    const html = await fetch(BASE + "/sign/" + token);
    expect(html.status).toBe(200);
    const s = await api("GET", "/api/sign/" + token);
    expect(s.status).toBe(200);
    expect(s.json.signing.status).toBe("pending");
    expect(s.json.page.title).toBe("SOW v1");
    expect(s.json.page.body_md).toContain("fractional CFO");
    // no leakage of unrelated fields
    expect(s.json.signing.token).toBe(token);
  });
  test("typed-name ceremony signs + hash verifies deterministically", async () => {
    const r = await api("POST", "/api/sign/" + token + "/sign", { signer_name: "Client CEO" });
    expect(r.status).toBe(200);
    const s = r.json.signing;
    expect(s.status).toBe("signed");
    expect(s.signature_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.signed_at).toBeTruthy();
    const recomputed = createHash("sha256")
      .update(`${BODY}\nClient CEO\nceo@client.com\n${s.signed_at}`).digest("hex");
    expect(s.signature_hash).toBe(recomputed);
  });
  test("double-sign rejected", async () => {
    const r = await api("POST", "/api/sign/" + token + "/sign", { signer_name: "Client CEO" });
    expect(r.status).toBe(409);
  });
  test("page shows signing status; revoke → token 404s", async () => {
    const st = await api("GET", "/api/pages/" + page.id + "/signing");
    expect(st.json.signing.status).toBe("signed");
    expect((await api("DELETE", "/api/pages/" + page.id + "/signing")).status).toBe(200);
    expect((await api("GET", "/api/sign/" + token)).status).toBe(404);
    expect((await api("POST", "/api/sign/" + token + "/sign", { signer_name: "X" })).status).toBe(404);
    expect((await fetch(BASE + "/sign/" + token)).status).toBe(404);
  });
  test("validation: bad email / missing name rejected; unknown token 404", async () => {
    const pg = await api("POST", "/api/pods/" + pod.id + "/pages", { title: "SOW v2", body_md: BODY });
    const pid = pg.json.page.id;
    expect((await api("POST", "/api/pages/" + pid + "/signing", { signer_name: "", signer_email: "ceo@client.com" })).status).toBe(400);
    expect((await api("POST", "/api/pages/" + pid + "/signing", { signer_name: "CEO", signer_email: "nope" })).status).toBe(400);
    expect((await api("GET", "/api/sign/" + "0".repeat(64))).status).toBe(404);
  });
});

// ---------- DOM-stubbed UI renders ----------
const SRC = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
const CSS = readFileSync(new URL("../public/styles.css", import.meta.url).pathname, "utf8");
function boot() {
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
  return windowStub.Podium as any;
}

describe("phase 2 UI renders", () => {
  const P = boot();
  const pod = { id: "p1", name: "Acme Foods", client_name: "Acme Foods Inc", color: "#c96f4a" };
  test("viewObjectives: progress bars, KRs, inline update + add forms", () => {
    const h = P.viewObjectives(pod, [{
      id: "o1", pod_id: "p1", title: "Cut burn", period: "2026-Q4", progress_pct: 60, status: "at_risk",
      key_results: [{ id: "k1", objective_id: "o1", title: "Renegotiate terms", target: "−$25k", current: "−$14k" }],
    }]);
    expect(h).toContain("Cut burn");
    expect(h).toContain("bar-fill");
    expect(h).toContain("60%");
    expect(h).toContain("At risk");
    expect(h).toContain("Renegotiate terms");
    expect(h).toContain("saveObjectiveProgress");
    expect(h).toContain("saveKeyResult");
    expect(h).toContain("New objective");
  });
  test("viewAlerts: cards with mark-seen", () => {
    const h = P.viewAlerts([
      { id: "a1", pod_id: "p1", pod_name: "Acme", kind: "overage_80", message: "at 81% — Adjust: #/pod/p1/time", seen: 0, created_at: new Date().toISOString() },
      { id: "a2", pod_id: "p1", pod_name: "Acme", kind: "overage_100", message: "done", seen: 1, created_at: new Date().toISOString() },
    ]);
    expect(h).toContain("alert-unseen");
    expect(h).toContain("markAlertSeen");
    expect(h).toContain("#/pod/p1/time");
  });
  test("viewValueLog: groups by week, block pills, decision bullets", () => {
    const h = P.viewValueLog([
      { id: "e1", day: "2026-10-07", pod_name: "Acme", hours: 4, note: "Board prep", block_type: "advisory", decisions: "Approved pricing\nShipped onboarding" },
      { id: "e2", day: "2026-10-08", pod_name: "Acme", hours: 2, note: "", block_type: "milestone", decisions: "" },
    ]);
    expect(h).toContain("Week of 2026-10-05");
    expect(h).toContain("block-advisory");
    expect(h).toContain("block-milestone");
    expect(h).toContain("Approved pricing");
    expect(h).toContain("Shipped onboarding");
    expect(h).toContain("6h total");
  });
  test("viewTimeTab has Timesheet/Value log toggle + block fields", () => {
    const h = P.viewTimeTab(pod,
      [{ pod_id: "p1", person_id: "u1", person_name: "Ava" }],
      [{ id: "u1", name: "Ava Reyes" }], "u1", "2026-10-05", []);
    expect(h).toContain("toggleValueLog");
    expect(h).toContain("Value log");
    expect(h).toContain('name="block_type"');
    expect(h).toContain('name="decisions"');
  });
  test("viewSigningBanner: none / pending / signed states", () => {
    const page = { id: "pg1", title: "SOW" };
    const none = P.viewSigningBanner(page, null);
    expect(none).toContain("Send for signature");
    const pend = P.viewSigningBanner(page, { status: "pending", signer_name: "CEO", signer_email: "ceo@x.com", token: "ab".repeat(32) });
    expect(pend).toContain("Awaiting signature");
    expect(pend).toContain("/sign/");
    const signed = P.viewSigningBanner(page, { status: "signed", signer_name: "CEO", signed_at: new Date().toISOString(), signature_hash: "cd".repeat(32) });
    expect(signed).toContain("Signed");
    expect(signed).toContain("cdcdcdcd");
  });
  test("alert bell renders badge with unread count", () => {
    const sidebar = P.renderSidebar();
    expect(sidebar).toContain("alert-bell");
    expect(sidebar).toContain("#/alerts");
  });
  test("stylesheet: phase-2 components are glass, mobile-first, reduced-motion safe", () => {
    for (const cls of [".alert-bell", ".bell-badge", ".obj-card", ".seg-toggle", ".block-advisory", ".vl-item", ".sign-banner", ".alert-unseen", ".public-wrap"]) {
      expect(CSS).toContain(cls);
    }
    expect(CSS).not.toMatch(/@media\s*\(\s*max-width/);
  });
});
