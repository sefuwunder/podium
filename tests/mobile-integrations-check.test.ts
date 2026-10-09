// Podium mobile-first + ClickUp + IMAP tests.
// - ClickUp client unit tests (mocked __podiumFetch, no network)
// - ClickUp + IMAP server routes (child server, PODIUM_MOCK_INTEGRATIONS=1,
//   PODIUM_MOCK_EMAIL=1 for canned IMAP — no sockets)
// - UI renders (DOM-stubbed app.js): tasks tab, inbox tab, settings cards,
//   labelTables mobile stacking
// - CSS static checks: mobile-first, glass, reduced-motion, snap-scroll
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ================= ClickUp client (mocked fetch) ================= */
import {
  clickupVerify, listTasks, createTask, closeTask, getListInfo,
} from "../src/clickup.ts";

function mockFetch(handler: (url: string, init: any) => any) {
  (globalThis as any).__podiumFetch = async (url: string, init: any = {}) => {
    const j = handler(url, init);
    return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
const TOKEN = "pk_test_token";

describe("clickup client", () => {
  test("verify returns the user", async () => {
    mockFetch((url) => {
      expect(url).toBe("https://api.clickup.com/api/v2/user");
      return { user: { id: 1, username: "tester", email: "t@x.co" } };
    });
    const u = await clickupVerify(TOKEN);
    expect(u.username).toBe("tester");
    expect(u.email).toBe("t@x.co");
  });

  test("listTasks maps fields", async () => {
    mockFetch(() => ({
      tasks: [{
        id: 42, name: "Kickoff", status: { status: "in progress", type: "custom", color: "#ff0" },
        due_date: "1760000000000",
        assignees: [{ id: 7, username: "ava", email: "ava@x.co" }],
        url: "https://app.clickup.com/t/42",
      }],
    }));
    const tasks = await listTasks(TOKEN, "list1");
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.id).toBe("42");
    expect(t.name).toBe("Kickoff");
    expect(t.status).toBe("in progress");
    expect(t.status_type).toBe("custom");
    expect(t.due_date).toBe(new Date(1760000000000).toISOString());
    expect(t.assignees[0].username).toBe("ava");
    expect(t.url).toContain("clickup.com");
  });

  test("createTask posts name/description/due_date as ms epoch", async () => {
    let seen: any = null;
    mockFetch((url, init) => {
      expect(url).toBe("https://api.clickup.com/api/v2/list/list1/task");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe(TOKEN);
      seen = JSON.parse(init.body);
      return { id: 99, name: seen.name, status: { status: "to do", type: "open" } };
    });
    const t = await createTask(TOKEN, "list1", {
      name: "Write SOW", description: "Draft it", due_date: "2026-11-01",
    });
    expect(seen.name).toBe("Write SOW");
    expect(seen.description).toBe("Draft it");
    expect(seen.due_date).toBe(new Date("2026-11-01").getTime());
    expect(t.id).toBe("99");
  });

  test("createTask rejects blank name and bad date", async () => {
    mockFetch(() => ({}));
    await expect(createTask(TOKEN, "list1", { name: "   " })).rejects.toThrow("name is required");
    await expect(createTask(TOKEN, "list1", { name: "x", due_date: "not-a-date" })).rejects.toThrow("bad due date");
  });

  test("closeTask resolves the done status then PUTs it", async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init.method || "GET"} ${url}`);
      if (url.endsWith("/list/list1")) {
        return { id: "list1", name: "Pod", statuses: [
          { status: "to do", type: "open" }, { status: "complete", type: "done" },
        ] };
      }
      const body = JSON.parse(init.body);
      expect(body.status).toBe("complete");
      return { id: "t1", name: "x", status: { status: "complete", type: "done" } };
    });
    const t = await closeTask(TOKEN, "t1", "list1");
    expect(calls[0]).toContain("GET https://api.clickup.com/api/v2/list/list1");
    expect(calls[1]).toContain("PUT https://api.clickup.com/api/v2/task/t1");
    expect(t.status_type).toBe("done");
  });

  test("closeTask prefers closed type and errors cleanly with no done status", async () => {
    mockFetch((url, init) => {
      const method = (init.method || "GET").toUpperCase();
      if (method === "PUT") {
        const body = JSON.parse(init.body);
        return { id: "t9", name: "x", status: { status: body.status, type: "closed" } };
      }
      if (url.endsWith("/list/a")) return { id: "a", name: "A", statuses: [{ status: "shipped", type: "closed" }] };
      return { id: "b", name: "B", statuses: [{ status: "to do", type: "open" }] };
    });
    // closed type is acceptable
    const t = await closeTask(TOKEN, "t9", "a");
    expect(t.status).toBe("shipped");
    // no done/closed type → clean 400
    const err = await closeTask(TOKEN, "t9", "b").catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/no done\/closed status/);
  });

  test("missing token / list → 400, never a network call", async () => {
    let called = false;
    mockFetch(() => { called = true; return {}; });
    await expect(listTasks("", "list1")).rejects.toMatchObject({ status: 400 });
    await expect(listTasks(TOKEN, "")).rejects.toMatchObject({ status: 400 });
    await expect(clickupVerify("")).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });
});

/* ================= email.ts wrapper (stubbed IMAP) ================= */
import {
  getPodInbox, getInboxBody, testImap, clearInboxCache, imapConfigured,
  imapConfigFromSettings, mockEmailDeps,
} from "../src/email.ts";

const stubSettings = (over: Record<string, string> = {}) => {
  const m: Record<string, string> = {
    imap_host: "mail.example.com", imap_port: "993",
    imap_user: "boss@example.com", imap_pass: "s3cret", ...over,
  };
  return (k: string) => m[k] || "";
};
const members = [
  { person_id: "u1", person_name: "Ava", person_email: "ava@x.co" },
  { person_id: "u2", person_name: "NoMail", person_email: "" },
  { person_id: "u3", person_name: "Priya", person_email: "priya@x.co" },
];

describe("email wrapper", () => {
  test("imapConfigured + config shaping", () => {
    expect(imapConfigured(stubSettings())).toBe(true);
    expect(imapConfigured(stubSettings({ imap_pass: "" }))).toBe(false);
    const cfg = imapConfigFromSettings(stubSettings());
    expect(cfg.host).toBe("mail.example.com");
    expect(cfg.port).toBe(993);
    expect(cfg.user).toBe("boss@example.com");
    expect(cfg.pass).toBe("s3cret");
  });

  test("unconfigured → clean 400, no socket", async () => {
    const deps = mockEmailDeps();
    let touched = false;
    const spy = { ...deps, latest: async (...a: any[]) => { touched = true; return deps.latest!(a[0], a[1]); } };
    await expect(getPodInbox("p1", members, stubSettings({ imap_host: "" }), { deps: spy, force: true }))
      .rejects.toMatchObject({ status: 400 });
    await expect(getInboxBody("p1", "x", stubSettings({ imap_host: "" }), { deps: spy }))
      .rejects.toMatchObject({ status: 400 });
    await expect(testImap(stubSettings({ imap_host: "" }), { deps: spy })).rejects.toMatchObject({ status: 400 });
    expect(touched).toBe(false);
  });

  test("cache miss → fetch; hit → no re-fetch; refresh → re-fetch", async () => {
    clearInboxCache("pcache");
    const deps = mockEmailDeps();
    let calls = 0;
    const spy = { ...deps, latest: async (c: any, e: string) => { calls++; return deps.latest!(c, e); } };
    const r1 = await getPodInbox("pcache", members, stubSettings(), { deps: spy, force: true });
    expect(r1.cached).toBe(false);
    expect(calls).toBe(2); // NoMail skipped (no email)
    expect(r1.items).toHaveLength(2);
    expect(r1.items[0].snippet.length).toBeGreaterThan(0);
    expect(r1.items[0].person_name).toBeTruthy();

    const r2 = await getPodInbox("pcache", members, stubSettings(), { deps: spy });
    expect(r2.cached).toBe(true);
    expect(calls).toBe(2); // cache hit — no new IMAP
    expect(r2.cachedAt).toBeTruthy();

    const r3 = await getPodInbox("pcache", members, stubSettings(), { deps: spy, force: true });
    expect(r3.cached).toBe(false);
    expect(calls).toBe(4); // refresh re-fetches
  });

  test("members without email are skipped", async () => {
    clearInboxCache("pskip");
    const deps = mockEmailDeps();
    const seen: string[] = [];
    const spy = { ...deps, latest: async (c: any, e: string) => { seen.push(e); return deps.latest!(c, e); } };
    const r = await getPodInbox("pskip", members, stubSettings(), { deps: spy, force: true });
    expect(seen).toEqual(["ava@x.co", "priya@x.co"]);
    expect(r.items.every((i) => i.email.includes("@"))).toBe(true);
  });

  test("body: inbox item re-fetches, sent item uses cached body, unknown → 404", async () => {
    clearInboxCache("pbody");
    const deps = mockEmailDeps();
    let bodyCalls = 0;
    const spy = {
      ...deps,
      body: async (c: any, u: string, m?: number) => { bodyCalls++; return deps.body!(c, u, m); },
    };
    const r = await getPodInbox("pbody", members.slice(0, 1), stubSettings(), { deps: spy, force: true });
    const uid = r.items[0].uid;
    const b = await getInboxBody("pbody", uid, stubSettings(), { deps: spy });
    expect(bodyCalls).toBe(1);
    expect(b.body).toContain("Full message body for " + uid);
    expect(b.subject).toBe(r.items[0].subject);
    await expect(getInboxBody("pbody", "nope", stubSettings(), { deps: spy })).rejects.toMatchObject({ status: 404 });
  });

  test("testImap validates", async () => {
    const ok = await testImap(stubSettings(), { deps: mockEmailDeps() });
    expect(ok).toEqual({ ok: true });
  });
});

/* ================= server routes ================= */
const DATA = mkdtempSync(join(tmpdir(), "podium-mi-"));
const PORT = "32311";
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
    env: { ...process.env, PODIUM_DATA: DATA, PORT, PODIUM_MOCK_INTEGRATIONS: "1", PODIUM_MOCK_EMAIL: "1" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + "/api/status"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("test server did not start");
});
afterAll(() => { try { proc.kill(); } catch {} });

describe("clickup routes", () => {
  let podId: string;
  beforeAll(async () => {
    const p = await api("POST", "/api/pods", { name: "CU Pod", client_name: "CU Inc" });
    podId = p.json.pod.id;
  });

  test("test without token → 400", async () => {
    const r = await api("POST", "/api/integrations/clickup/test", {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not connected/);
  });

  test("test with token → user", async () => {
    await api("POST", "/api/settings", { clickup_token: "pk_test_123" });
    const r = await api("POST", "/api/integrations/clickup/test", {});
    expect(r.status).toBe(200);
    expect(r.json.user.username).toBe("tester");
  });

  test("tasks without linked list → 400; link list; list/create/close", async () => {
    const empty = await api("GET", `/api/pods/${podId}/tasks`);
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/No ClickUp list/);

    const link = await api("PUT", `/api/pods/${podId}/clickup-list`, { list_id: "list123" });
    expect(link.status).toBe(200);
    expect(link.json.pod.clickup_list_id).toBe("list123");

    const list = await api("GET", `/api/pods/${podId}/tasks`);
    expect(list.status).toBe(200);
    expect(list.json.tasks).toHaveLength(2);
    expect(list.json.tasks[0].name).toBe("Kickoff deck");

    const created = await api("POST", `/api/pods/${podId}/tasks`, {
      name: "Write SOW", description: "d", due_date: "2026-12-01",
    });
    expect(created.status).toBe(201);
    expect(created.json.task.name).toBe("Write SOW");

    const bad = await api("POST", `/api/pods/${podId}/tasks`, { name: "  " });
    expect(bad.status).toBe(400);

    const closed = await api("POST", `/api/pods/${podId}/tasks/t1/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.json.task.status_type).toBe("done");
  });

  test("close with no done status → clean 400", async () => {
    await api("PUT", `/api/pods/${podId}/clickup-list`, { list_id: "list-nodone" });
    const r = await api("POST", `/api/pods/${podId}/tasks/t1/close`, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no done\/closed status/);
  });

  test("clickup_token is masked in settings GET", async () => {
    const s = await api("GET", "/api/settings");
    expect(s.json.settings.clickup_token.set).toBe(true);
    expect(s.json.settings.clickup_token.preview).toMatch(/••••/);
    expect(JSON.stringify(s.json)).not.toContain("pk_test_123");
  });
});

describe("imap routes", () => {
  let podId: string; let u1: string;
  beforeAll(async () => {
    const p1 = await api("POST", "/api/people", { name: "Ava", email: "ava@x.co", title: "CEO", hourly_rate_cents: 100 });
    u1 = p1.json.person.id;
    const p2 = await api("POST", "/api/people", { name: "NoMail", email: "", title: "CFO", hourly_rate_cents: 100 });
    const pod = await api("POST", "/api/pods", { name: "Mail Pod" });
    podId = pod.json.pod.id;
    await api("POST", `/api/pods/${podId}/members`, { person_id: u1 });
    await api("POST", `/api/pods/${podId}/members`, { person_id: p2.json.person.id });
  });

  test("unconfigured → 400 with settings hint", async () => {
    const r = await api("GET", `/api/pods/${podId}/inbox`);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not configured/);
    const t = await api("POST", "/api/integrations/imap/test", {});
    expect(t.status).toBe(400);
  });

  test("configured → items, cache, refresh, body", async () => {
    await api("POST", "/api/settings", {
      imap_host: "mail.example.com", imap_port: "993",
      imap_user: "boss@example.com", imap_pass: "s3cret",
    });
    const r1 = await api("GET", `/api/pods/${podId}/inbox`);
    expect(r1.status).toBe(200);
    expect(r1.json.cached).toBe(false);
    expect(r1.json.items).toHaveLength(1); // NoMail skipped
    expect(r1.json.items[0].person_name).toBe("Ava");
    expect(r1.json.items[0].snippet.length).toBeGreaterThan(0);

    const r2 = await api("GET", `/api/pods/${podId}/inbox`);
    expect(r2.json.cached).toBe(true);
    expect(r2.json.cachedAt).toBeTruthy();

    const r3 = await api("POST", `/api/pods/${podId}/inbox/refresh`, {});
    expect(r3.json.cached).toBe(false);

    const uid = r1.json.items[0].uid;
    const b = await api("GET", `/api/pods/${podId}/inbox/${encodeURIComponent(uid)}/body`);
    expect(b.status).toBe(200);
    expect(b.json.body).toContain("Full message body for " + uid);

    const bad = await api("GET", `/api/pods/${podId}/inbox/nope/body`);
    expect(bad.status).toBe(404);
  });

  test("imap secrets are masked in settings GET", async () => {
    const s = await api("GET", "/api/settings");
    expect(s.json.settings.imap_pass.set).toBe(true);
    expect(s.json.settings.imap_pass.preview).toMatch(/••••/);
    expect(s.json.settings.imap_host.preview).toBe("mail.example.com");
    expect(s.json.settings.imap_port.preview).toBe("993");
    expect(JSON.stringify(s.json)).not.toContain("s3cret");
  });

  test("imap test endpoint validates", async () => {
    const t = await api("POST", "/api/integrations/imap/test", {});
    expect(t.status).toBe(200);
    expect(t.json.ok).toBe(true);
  });
});

/* ================= UI renders (DOM stub) ================= */
import { readFileSync as readFs } from "node:fs";
const SRC = readFs(new URL("../public/app.js", import.meta.url).pathname, "utf8");

function boot(reduced: boolean) {
  const els: Record<string, any> = {};
  const mkEl = (id: string): any => {
    const e: any = {
      innerHTML: "", value: "", textContent: "",
      style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      getAttribute: () => "", setAttribute() {}, removeAttribute() {},
      appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, focus() {}, click() {},
    };
    e.children = [];
    return (els[id] = e);
  };
  const documentStub: any = {
    getElementById: (id: string) => els[id] || mkEl(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => mkEl("dyn"),
    body: { innerText: "" },
  };
  const windowStub: any = {
    location: { hash: "#/home" },
    scrollTo() {}, addEventListener() {}, open() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  const fn = new Function(
    "window", "document", "location", "fetch", "localStorage", "matchMedia", "confirm", "prompt", "module", "scrollTo",
    SRC,
  );
  fn(
    windowStub, documentStub, windowStub.location,
    () => Promise.reject(new Error("no fetch in stub")),
    windowStub.localStorage,
    () => ({ matches: reduced }),
    () => true, () => null, { exports: {} }, () => {},
  );
  return { Podium: windowStub.Podium as any, els };
}

describe("new views render", () => {
  const { Podium: P } = boot(false);
  const pod = { id: "p1", name: "Acme", client_name: "Acme Inc", color: "#c96f4a", clickup_list_id: "list1", billing_type: "hourly" };

  test("viewTasks: linked list shows tasks + create form", () => {
    const h = P.viewTasks(pod, [
      { id: "t1", name: "Kickoff", status: "to do", status_type: "open", status_color: "#d9d9d9", due_date: null, assignees: [{ username: "ava", email: "a@x.co" }], url: "https://app.clickup.com/t/1" },
      { id: "t2", name: "Done thing", status: "complete", status_type: "done", status_color: "#6bc950", due_date: null, assignees: [], url: "" },
    ], "");
    expect(h).toContain("Kickoff");
    expect(h).toContain("is-done");
    expect(h).toContain("Open in ClickUp");
    expect(h).toContain("New task");
    expect(h).toContain("list1");
  });

  test("viewTasks: error states link to settings", () => {
    const h = P.viewTasks({ ...pod, clickup_list_id: "" }, [], "ClickUp is not connected — add a personal token in Settings");
    expect(h).toContain("#/settings");
    const h2 = P.viewTasks({ ...pod, clickup_list_id: "" }, [], "No ClickUp list linked — set one on the pod");
    expect(h2).toContain("Link a list above");
  });

  test("viewInbox: items, cached stamp, unconfigured state", () => {
    const h = P.viewInbox(pod, {
      items: [{
        uid: "u1", person_name: "Ava", email: "ava@x.co", from: "Ava <ava@x.co>",
        subject: "Re: planning", date: new Date().toISOString(), direction: "in",
        snippet: "hello world", mailbox: "inbox",
      }],
      cached: true, cachedAt: new Date().toISOString(),
    }, false);
    expect(h).toContain("Re: planning");
    expect(h).toContain("hello world");
    expect(h).toContain("Cached");
    expect(h).toContain("Refresh");
    expect(h).toContain("Read full email");

    const h2 = P.viewInbox(pod, { items: [], error: "IMAP is not configured — add your mailbox in Settings" }, false);
    expect(h2).toContain("#/settings");

    const h3 = P.viewInbox(pod, null, true);
    expect(h3).toContain("Checking the mailbox");
  });

  test("viewSettings includes ClickUp + IMAP cards", () => {
    const h = P.viewSettings({ settings: {}, stripeMode: "test" }, []);
    expect(h).toContain("ClickUp");
    expect(h).toContain("clickup_token");
    expect(h).toContain("Mailbox (IMAP)");
    expect(h).toContain("imap_host");
    expect(h).toContain("imap_pass");
  });

  test("labelTables decorates cells with data-label", () => {
    const root: any = {
      tables: [] as any[],
      querySelectorAll(sel: string) { return sel === "table" ? this.tables : []; },
    };
    const mkRow = (cells: string[], header = false) => {
      const els = cells.map((c) => ({
        textContent: c, attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) { this.attrs[k] = v; },
      }));
      return {
        querySelectorAll: (s: string) => (s === (header ? "th" : "td") ? els : []),
      };
    };
    const ths = ["Name", "Amount"];
    const table: any = {
      rows: [mkRow(ths, true), mkRow(["Acme", "$10"])],
      querySelectorAll(s: string) { return s === "tr" ? this.rows : []; },
    };
    root.tables = [table];
    P.labelTables(root);
    const td = table.rows[1].querySelectorAll("td")[0];
    expect(td.attrs["data-label"]).toBe("Name");
    const td2 = table.rows[1].querySelectorAll("td")[1];
    expect(td2.attrs["data-label"]).toBe("Amount");
  });
});

/* ================= CSS static checks ================= */
const CSS = readFs(new URL("../public/styles.css", import.meta.url).pathname, "utf8");

describe("mobile-first stylesheet", () => {
  test("mobile-first: base is phone, desktop is min-width enhancement", () => {
    expect(CSS).toContain("@media (min-width: 900px)");
    expect(CSS).not.toMatch(/@media\s*\(\s*max-width/); // no desktop-first queries
    // sidebar hidden at base, shown at desktop
    expect(CSS).toMatch(/\.sidebar\s*\{\s*display:\s*none/);
  });

  test("bottom nav is first-class on mobile", () => {
    expect(CSS).toContain(".bottomnav");
    expect(CSS).toMatch(/\.bottomnav\s*\{[^}]*position:\s*fixed/);
    expect(CSS).toMatch(/\.bottomnav a\s*\{[^}]*min-height:\s*52px/);
  });

  test("glass: backdrop-filter + translucent cards, warm palette kept", () => {
    expect(CSS).toContain("backdrop-filter");
    expect(CSS).toContain("rgba(255, 255, 255, 0.72)");
    expect(CSS).toContain("--terra: #c96f4a");
    expect(CSS).not.toContain("#00ffff");
  });

  test("kanban snap-scroll on mobile", () => {
    expect(CSS).toContain("scroll-snap-type: x mandatory");
    expect(CSS).toContain("scroll-snap-align: start");
  });

  test("touch targets ≥44px", () => {
    expect(CSS).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/\.tab\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/input,\s*textarea,\s*select\s*\{[^}]*min-height:\s*44px/);
  });

  test("tables stack via data-label on mobile", () => {
    expect(CSS).toContain("attr(data-label)");
  });

  test("timer button full-width on mobile", () => {
    expect(CSS).toMatch(/\.timer-btn\s*\{[^}]*width:\s*100%/);
  });

  test("reduced-motion kills all new animation", () => {
    const m = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("animation: none !important");
    expect(m![1]).toContain("transition: none !important");
  });

  test("keyframes exist for view/card entrance + pulse", () => {
    expect(CSS).toContain("@keyframes viewIn");
    expect(CSS).toContain("@keyframes cardIn");
    expect(CSS).toContain("@keyframes pulse");
  });
});
