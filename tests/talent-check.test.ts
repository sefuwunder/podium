// Podium talent & pod allocation engine tests.
// - people fields (skills, max hours, rate tier, bio) + validation
// - conflicts CRUD
// - capacity math (explicit hours, retainer even-split fallback, hourly pods = 0, unlimited)
// - pod-builder suggest: scoring math, conflict exclusion, capacity fit
// - pod-builder create wiring
// - match portal: enable/revoke, anonymization of HTML + JSON, 404s
// - UI renders (DOM-stubbed app.js) + CSS checks
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "podium-talent-"));
const PORT = "32321";
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

async function mkPerson(body: any) {
  const r = await api("POST", "/api/people", body);
  expect(r.status).toBe(201);
  return r.json.person;
}

describe("people talent fields", () => {
  test("skills normalize (trim, dedupe case-insensitive), tier + bio persist", async () => {
    const p = await mkPerson({
      name: "Talent Test One", title: "Fractional CEO", max_weekly_hours: 40,
      skills: "fintech, Turnaround, fintech ,  ", rate_tier: "II", bio: "Two decades turning companies around.",
    });
    expect(p.max_weekly_hours).toBe(40);
    expect(p.skills).toEqual(["fintech", "Turnaround"]);
    expect(p.rate_tier).toBe("II");
    expect(p.bio).toBe("Two decades turning companies around.");
    const g = await api("GET", "/api/people/" + p.id);
    expect(g.json.person.skills).toEqual(["fintech", "Turnaround"]);
  });
  test("invalid tier and hours rejected", async () => {
    const bad1 = await api("POST", "/api/people", { name: "Bad Tier", rate_tier: "IV" });
    expect(bad1.status).toBe(400);
    const bad2 = await api("POST", "/api/people", { name: "Bad Hours", max_weekly_hours: -5 });
    expect(bad2.status).toBe(400);
  });
  test("update person keeps fields", async () => {
    const p = await mkPerson({ name: "Talent Test Two" });
    const u = await api("PUT", "/api/people/" + p.id, { max_weekly_hours: 20, skills: ["cpg"], rate_tier: "$$" });
    expect(u.status).toBe(200);
    expect(u.json.person.max_weekly_hours).toBe(20);
    expect(u.json.person.skills).toEqual(["cpg"]);
    expect(u.json.person.rate_tier).toBe("$$");
  });
});

describe("conflicts register", () => {
  test("CRUD + validation", async () => {
    const p = await mkPerson({ name: "Conflict Test Exec" });
    const bad = await api("POST", `/api/people/${p.id}/conflicts`, { reason: "no company" });
    expect(bad.status).toBe(400);
    const c = await api("POST", `/api/people/${p.id}/conflicts`, { company: "Rival Inc", reason: "Board seat" });
    expect(c.status).toBe(201);
    expect(c.json.conflict.company).toBe("Rival Inc");
    const list = await api("GET", `/api/people/${p.id}/conflicts`);
    expect(list.json.conflicts).toHaveLength(1);
    const del = await api("DELETE", `/api/people/${p.id}/conflicts/${c.json.conflict.id}`);
    expect(del.status).toBe(200);
    const list2 = await api("GET", `/api/people/${p.id}/conflicts`);
    expect(list2.json.conflicts).toHaveLength(0);
  });
  test("unknown person → 404", async () => {
    const r = await api("GET", "/api/people/nope/conflicts");
    expect(r.status).toBe(404);
  });
});

describe("capacity report", () => {
  test("explicit hours, retainer even-split fallback, hourly = 0, unlimited cap", async () => {
    const a = await mkPerson({ name: "Capacity Alice", max_weekly_hours: 40, skills: ["fintech"] });
    const b = await mkPerson({ name: "Capacity Bob" });
    // retainer pod, 40h cap, 2 members → 20h each by even split
    const pod1 = (await api("POST", "/api/pods", { name: "Cap Pod 1", client_name: "CapCo" })).json.pod;
    await api("PUT", `/api/pods/${pod1.id}/retainer`, { billing_type: "retainer", retainer_hours: 40 });
    await api("POST", `/api/pods/${pod1.id}/members`, { person_id: a.id });
    await api("POST", `/api/pods/${pod1.id}/members`, { person_id: b.id });
    // hourly pod → 0 unless explicit
    const pod2 = (await api("POST", "/api/pods", { name: "Cap Pod 2", client_name: "HourlyCo" })).json.pod;
    await api("POST", `/api/pods/${pod2.id}/members`, { person_id: a.id });
    const set = await api("PUT", `/api/pods/${pod2.id}/members/${a.id}`, { allocated_hours: 5 });
    expect(set.status).toBe(200);
    expect(set.json.member.allocated_hours).toBe(5);
    const cap = (await api("GET", "/api/capacity")).json.capacity;
    const alice = cap.find((c: any) => c.person_id === a.id);
    expect(alice.max_monthly_hours).toBeCloseTo(40 * 4.33, 1);
    expect(alice.allocated).toBeCloseTo(25, 2); // 20 even-split + 5 explicit
    expect(alice.load_pct).toBeCloseTo(25 / (40 * 4.33), 4);
    expect(alice.pod_count).toBe(2);
    expect(alice.pods.find((x: any) => x.pod_id === pod1.id).allocated_hours).toBe(20);
    const bob = cap.find((c: any) => c.person_id === b.id);
    expect(bob.max_monthly_hours).toBeNull();
    expect(bob.load_pct).toBeNull();
    expect(bob.allocated).toBe(20);
    // explicit allocation overrides the split
    await api("PUT", `/api/pods/${pod1.id}/members/${a.id}`, { allocated_hours: 30 });
    const cap2 = (await api("GET", "/api/capacity")).json.capacity;
    expect(cap2.find((c: any) => c.person_id === a.id).allocated).toBeCloseTo(35, 2);
    // negative hours rejected; blank clears to auto
    expect((await api("PUT", `/api/pods/${pod1.id}/members/${a.id}`, { allocated_hours: -1 })).status).toBe(400);
    await api("PUT", `/api/pods/${pod1.id}/members/${a.id}`, { allocated_hours: null });
  });
});

describe("pod builder", () => {
  let sId: string, tId: string;
  beforeAll(async () => {
    const s = await mkPerson({ name: "Builder Sam", title: "Fractional COO", max_weekly_hours: 40, skills: ["fintech", "turnaround"], rate_tier: "III" });
    const t = await mkPerson({ name: "Builder Tess", title: "Fractional CFO", max_weekly_hours: 40, skills: ["fintech"], rate_tier: "$" });
    sId = s.id; tId = t.id;
    await api("POST", `/api/people/${tId}/conflicts`, { company: "Rival Inc" });
  });
  test("scoring math: +2/skill, +1 capacity fit", async () => {
    const r = await api("POST", "/api/pod-builder/suggest", { skills: ["fintech", "turnaround"], hours: 10, exclude_company: "Other Co" });
    expect(r.status).toBe(200);
    const sam = r.json.suggestions.find((x: any) => x.person_id === sId);
    expect(sam.score).toBe(5); // +4 skills, +1 capacity
    expect(sam.breakdown).toContain("+4 skills");
    expect(sam.breakdown).toContain("+1 capacity");
    expect(sam.reasons.join(" ")).toContain("matches fintech, turnaround");
    expect(sam.rate_tier).toBe("III");
  });
  test("conflict with exclude_company is excluded outright", async () => {
    const r = await api("POST", "/api/pod-builder/suggest", { skills: ["fintech"], hours: 10, exclude_company: "rival inc" });
    expect(r.json.suggestions.some((x: any) => x.person_id === tId)).toBe(false);
    const r2 = await api("POST", "/api/pod-builder/suggest", { skills: ["fintech"], hours: 10 });
    const tess = r2.json.suggestions.find((x: any) => x.person_id === tId);
    expect(tess).toBeTruthy();
    expect(tess.score).toBe(3); // +2 skill, +1 capacity
  });
  test("no capacity fit → no +1", async () => {
    const r = await api("POST", "/api/pod-builder/suggest", { skills: ["fintech", "turnaround"], hours: 10000 });
    const sam = r.json.suggestions.find((x: any) => x.person_id === sId);
    expect(sam.score).toBe(4); // +4 skills, no capacity point
    expect(sam.breakdown).not.toContain("+1 capacity");
  });
  test("create pod from suggestion: naming, members, hours", async () => {
    const r = await api("POST", "/api/pod-builder/create", {
      company: "Globex", allocations: [{ person_id: sId, allocated_hours: 12 }, { person_id: tId, allocated_hours: 8 }],
    });
    expect(r.status).toBe(201);
    expect(r.json.pod.name).toBe("Globex Pod");
    expect(r.json.pod.client_name).toBe("Globex");
    const pod = (await api("GET", "/api/pods/" + r.json.pod.id)).json;
    const s = pod.members.find((m: any) => m.person_id === sId);
    expect(s.allocated_hours).toBe(12);
    expect(pod.members.find((m: any) => m.person_id === tId).allocated_hours).toBe(8);
    // validation
    expect((await api("POST", "/api/pod-builder/create", { company: "", allocations: [{ person_id: sId }] })).status).toBe(400);
    expect((await api("POST", "/api/pod-builder/create", { company: "X", allocations: [] })).status).toBe(400);
    expect((await api("POST", "/api/pod-builder/create", { company: "X", allocations: [{ person_id: "nope" }] })).status).toBe(404);
  });
});

describe("client match portal", () => {
  let podId: string, slug: string, fullName: string, email: string;
  beforeAll(async () => {
    fullName = "Quinn Abernathy";
    email = "quinn.match@example.com";
    const p = await mkPerson({
      name: fullName, email, title: "Fractional CMO",
      skills: ["fintech", "growth"], rate_tier: "II", bio: "Scaled three fintech brands.",
    });
    const pod = (await api("POST", "/api/pods", { name: "Match Test Pod", client_name: "MatchCo" })).json.pod;
    podId = pod.id;
    await api("POST", `/api/pods/${podId}/members`, { person_id: p.id });
    const en = await api("POST", `/api/pods/${podId}/match-link`, { blurb: "Series A fintech — needs CMO." });
    expect(en.status).toBe(200);
    expect(en.json.pod.match_visible).toBe(1);
    slug = en.json.pod.match_slug;
    expect(en.json.url).toBe("/match/" + slug);
  });
  test("JSON is anonymized: first name + last initial, no email/full name/rates", async () => {
    const r = await api("GET", "/api/match/" + slug);
    expect(r.status).toBe(200);
    expect(r.json.pod.name).toBe("Match Test Pod");
    expect(r.json.pod.blurb).toBe("Series A fintech — needs CMO.");
    const m = r.json.members[0];
    expect(m.display_name).toBe("Quinn A.");
    expect(m.title).toBe("Fractional CMO");
    expect(m.skills).toEqual(["fintech", "growth"]);
    expect(m.rate_band).toBe("$$");
    expect(m.bio).toBe("Scaled three fintech brands.");
    expect("email" in m).toBe(false);
    const raw = JSON.stringify(r.json);
    expect(raw).not.toContain(email);
    expect(raw).not.toContain(fullName);
    expect(raw).not.toContain("27500");
  });
  test("public HTML page contains no email or full name", async () => {
    const r = await fetch(BASE + "/match/" + slug);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html.includes(email)).toBe(false);
    expect(html.includes(fullName)).toBe(false);
    // the static shell carries no PII; data loads via the JSON endpoint (tested above)
  });
  test("bogus slug → 404 on page and API", async () => {
    expect((await api("GET", "/api/match/definitely-not-real")).status).toBe(404);
    expect((await fetch(BASE + "/match/definitely-not-real")).status).toBe(404);
  });
  test("revoked link → 404 everywhere", async () => {
    const rev = await api("DELETE", `/api/pods/${podId}/match-link`);
    expect(rev.status).toBe(200);
    expect(rev.json.pod.match_visible).toBe(0);
    expect(rev.json.pod.match_slug).toBeNull();
    expect((await api("GET", "/api/match/" + slug)).status).toBe(404);
    expect((await fetch(BASE + "/match/" + slug)).status).toBe(404);
  });
  test("re-enable mints a fresh slug", async () => {
    const en = await api("POST", `/api/pods/${podId}/match-link`, {});
    expect(en.json.pod.match_slug).not.toBe(slug);
    expect((await api("GET", "/api/match/" + en.json.pod.match_slug)).status).toBe(200);
  });
});

/* ================= UI renders (DOM-stubbed app.js) ================= */
const SRC = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
const CSS = readFileSync(new URL("../public/styles.css", import.meta.url).pathname, "utf8");
const INDEX = readFileSync(new URL("../public/index.html", import.meta.url).pathname, "utf8");

function boot() {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ||= { innerHTML: "", value: "", classList: { toggle() {} }, getAttribute: () => "", focus() {}, select() {}, scrollIntoView() {} });
  const documentStub: any = {
    getElementById: (id: string) => el(id),
    querySelectorAll: () => [],
    createElement: () => el("dyn"),
    body: { innerText: "" },
    execCommand: () => true,
  };
  const windowStub: any = {
    location: { hash: "#/home", origin: "http://x" },
    scrollTo() {}, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  const fn = new Function(
    "window", "document", "location", "fetch", "localStorage", "matchMedia", "confirm", "prompt", "module", "scrollTo",
    SRC
  );
  const locStub = { hash: "#/home", origin: "http://x" };
  fn(
    windowStub, documentStub, locStub,
    () => Promise.reject(new Error("no fetch in stub")),
    windowStub.localStorage,
    () => ({ matches: false }),
    () => true, () => null, { exports: {} }, () => {}
  );
  return windowStub.Podium as any;
}

describe("talent UI", () => {
  const sample = [
    { person_id: "u1", person_name: "Ava Reyes", title: "Fractional CEO", skills: ["fintech", "turnaround"], rate_tier: "III", max_weekly_hours: 40, max_monthly_hours: 173.2, allocated: 160, load_pct: 0.92, pod_count: 3, conflict_count: 1 },
    { person_id: "u2", person_name: "Bo Kim", title: "Fractional CTO", skills: [], rate_tier: "", max_weekly_hours: null, max_monthly_hours: null, allocated: 12, load_pct: null, pod_count: 1, conflict_count: 0 },
  ];
  test("viewTalent renders load bars, tiers, skill tags, conflict badge", () => {
    const Podium = boot();
    const h = Podium.viewTalent(sample, "", "load");
    expect(h).toContain("Ava Reyes");
    expect(h).toContain("load-warn"); // 92% → amber
    expect(h).toContain("fintech");
    expect(h).toContain("III");
    expect(h).toContain("1 conflict");
    expect(h).toContain("no cap set"); // unlimited exec
    expect(h).toContain("Bo Kim");
  });
  test("viewTalent filter + red overload band", () => {
    const Podium = boot();
    const over = [{ ...sample[0], allocated: 180, load_pct: 1.04 }];
    const h = Podium.viewTalent(over, "turnaround", "load");
    expect(h).toContain("load-over");
    expect(h).not.toContain("Bo Kim");
  });
  test("viewBuilder renders form and ranked picks", () => {
    const Podium = boot();
    const b = Podium.freshBuilder();
    b.allSkills = ["fintech", "turnaround"];
    b.suggestions = [{
      person_id: "u1", person_name: "Ava Reyes", title: "Fractional CEO", skills: ["fintech"],
      rate_tier: "III", free_hours: 13.2, score: 3, breakdown: ["+2 skills", "+1 capacity"],
      reasons: ["matches fintech", "13.2h free of 173.2h/mo cap"],
    }];
    b.picked = { u1: true };
    b.company = "Globex"; b.hours = 20;
    const h = Podium.viewBuilder(b);
    expect(h).toContain("Client need");
    expect(h).toContain("Find matches");
    expect(h).toContain("3 pts");
    expect(h).toContain("matches fintech");
    expect(h).toContain("Create pod (1)");
  });
  test("viewMatchPortal shows enable state then live link", () => {
    const Podium = boot();
    const off = Podium.viewMatchPortal({ id: "p1", match_visible: 0, match_slug: null, match_blurb: "" });
    expect(off).toContain("Enable match link");
    const on = Podium.viewMatchPortal({ id: "p1", match_visible: 1, match_slug: "abc-123", match_blurb: "hi" });
    expect(on).toContain("/match/abc-123");
    expect(on).toContain("Revoke");
  });
  test("stylesheet: load colors, skill tags, glass, reduced-motion", () => {
    expect(CSS).toContain(".bar-fill.load-ok");
    expect(CSS).toContain(".bar-fill.load-warn");
    expect(CSS).toContain(".bar-fill.load-over");
    expect(CSS).toContain(".skill-tag");
    expect(CSS).toContain(".conflict-badge");
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
  });
  test("talent is in sidebar + bottom nav", () => {
    expect(SRC).toContain('href="#/talent"');
    expect(INDEX).toContain('data-v="talent"');
  });
});
