// Podium UI smoke test — evals public/app.js with stubbed DOM, renders the
// main views with sample data, asserts they produce sane HTML. Also exercises
// the reduced-motion path.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
const CSS = readFileSync(new URL("../public/styles.css", import.meta.url).pathname, "utf8");

function boot(reduced: boolean) {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ||= { innerHTML: "", value: "", classList: { toggle() {} }, getAttribute: () => "", focus() {}, scrollIntoView() {} });
  const documentStub: any = {
    getElementById: (id: string) => el(id),
    querySelectorAll: () => [],
    createElement: () => el("dyn"),
    body: { innerText: "" },
  };
  const windowStub: any = {
    location: { hash: "#/home" },
    scrollTo() {},
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  const mod: any = { exports: {} };
  const fn = new Function(
    "window", "document", "location", "fetch", "localStorage", "matchMedia", "confirm", "prompt", "module", "scrollTo",
    SRC
  );
  const locStub = { hash: "#/home" };
  fn(
    windowStub, documentStub, locStub,
    () => Promise.reject(new Error("no fetch in stub")),
    windowStub.localStorage,
    () => ({ matches: reduced }),
    () => true, () => null, mod, () => {}
  );
  return windowStub.Podium as any;
}

const samplePod = { id: "p1", name: "Acme Foods", client_name: "Acme Foods Inc", color: "#c96f4a" };
const sampleMembers = [
  { pod_id: "p1", person_id: "u1", role: "Lead", person_name: "Ava Reyes" },
  { pod_id: "p1", person_id: "u2", role: "Finance", person_name: "Priya Shah" },
];
const samplePeople = [
  { id: "u1", name: "Ava Reyes", email: "ava@x.co", title: "Fractional CEO", hourly_rate_cents: 27500 },
  { id: "u2", name: "Priya Shah", email: "priya@x.co", title: "Fractional CFO", hourly_rate_cents: 25000 },
];
const sampleChannels = [{ id: "c1", pod_id: "p1", name: "general" }];
const sampleMessages = [{
  id: "m1", author_name: "Ava Reyes", body_md: "Hello **pod**", created_at: new Date().toISOString(),
  replies: [{ id: "m2", author_name: "Priya Shah", body_md: "Hi *there*", created_at: new Date().toISOString(), replies: [] }],
}];
const samplePages = [{ id: "pg1", title: "Q4 Priorities", updated_at: new Date().toISOString(), updated_by: "Ava" }];
const samplePeriods = [
  { id: "per1", label: "October", start_day: "2026-10-01", end_day: "2026-10-31", status: "open" },
  { id: "per2", label: "September", start_day: "2026-09-01", end_day: "2026-09-30", status: "closed" },
];

describe("markdown renderer", () => {
  const P = boot(false);
  test("headings, bold, italic, code, links, lists", () => {
    const h = P.md("# Title\n\nHello **bold** and *italic* with `code`.\n\n- one\n- two\n\n[link](https://example.com)");
    expect(h).toContain("<h3>Title</h3>");
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain("<em>italic</em>");
    expect(h).toContain("<code>code</code>");
    expect(h).toContain('<a href="https://example.com"');
    expect(h).toContain("<ul>");
  });
  test("escapes HTML", () => {
    expect(P.md('<script>alert(1)</script>')).not.toContain("<script>");
    expect(P.md('<script>alert(1)</script>')).toContain("&lt;script&gt;");
  });
  test("money formatting", () => {
    expect(P.money(27500)).toBe("$275.00");
    expect(P.money(2500000)).toBe("$25,000.00");
  });
});

describe("views render without throwing", () => {
  for (const reduced of [false, true]) {
    const P = boot(reduced);
    const tag = reduced ? "reduced-motion" : "full-motion";
    test(`sidebar (${tag})`, () => {
      const h = P.renderSidebar.call(null) as string;
      // renderSidebar uses state internally; call via a pod list through viewPods instead
      expect(typeof h).toBe("string");
    });
    test(`home (${tag})`, () => {
      const h = P.viewHome({ week: { from: "2026-10-05", to: "2026-10-11" }, hoursPerPod: [{ pod_name: "Acme", color: "#c96f4a", hours: 12 }], openPeriod: { label: "Oct" }, openPeriodPerPerson: [{ person_name: "Ava", hours: 8 }] });
      expect(h).toContain("Dashboard");
      expect(h).toContain("Acme");
    });
    test(`pods (${tag})`, () => {
      const h = P.viewPods([{ ...samplePod, members: 4, channels: 3 }]);
      expect(h).toContain("Acme Foods");
      expect(h).toContain("New pod");
    });
    test(`pod head + channels (${tag})`, () => {
      const h = P.viewPodHead(samplePod, "channels", sampleMembers);
      expect(h).toContain("Acme Foods");
      expect(h).toContain("Ava Reyes");
      const c = P.viewChannels(sampleChannels, "c1", sampleMessages, null, sampleMembers, "p1");
      expect(c).toContain("# general");
      expect(c).toContain("<strong>pod</strong>");
      expect(c).toContain("Hi <em>there</em>");
      expect(c).toContain("Reply in thread");
    });
    test(`pod head hamburger menu (${tag})`, () => {
      const h = P.viewPodHead(samplePod, "channels", sampleMembers);
      // hamburger button next to the pod name, menu hidden by default
      expect(h).toContain('class="menu-btn"');
      expect(h).toContain('id="pod-menu" hidden');
      expect(h).toContain("togglePodMenu");
      // members + match portal live inside the menu, not as standalone cards
      expect(h).toContain("<h4>Members</h4>");
      expect(h).toContain("<h4>Client match portal</h4>");
      expect(h).toContain("Ava Reyes");
      expect(h).toContain("Enable match link");
      expect(h).not.toContain("<h3>Members</h3>");
      expect(h).not.toContain("<h3>Client match portal</h3>");
      // stylesheet carries the dropdown chrome
      expect(CSS).toContain(".menu-pop");
      expect(CSS).toContain(".menu-btn");
    });
    test(`pages (${tag})`, () => {
      const h = P.viewPages(samplePages, false, null);
      expect(h).toContain("Q4 Priorities");
      expect(h).toContain("New page");
      const e = P.viewPages(samplePages, true, null);
      expect(e).toContain("page-preview");
    });
    test(`time tab (${tag})`, () => {
      const h = P.viewTimeTab(samplePod, sampleMembers, samplePeople, "u1", "2026-10-05", []);
      expect(h).toContain("Log time");
      expect(h).toContain("Ava Reyes");
    });
    test(`people (${tag})`, () => {
      const h = P.viewPeople(samplePeople, { u1: 10 });
      expect(h).toContain("Ava Reyes");
      expect(h).toContain("$275.00/hr");
    });
    test(`payroll (${tag})`, () => {
      const h = P.viewPayroll(samplePeriods, null);
      expect(h).toContain("Pay periods");
      expect(h).toContain("No money moves through Podium");
      const d = P.viewPayroll(samplePeriods, {
        period: samplePeriods[0],
        statements: [{ person_name: "Ava Reyes", pod_name: "Acme Foods", hours: 2.5, rate_cents: 27500, amount_cents: 68750 }],
      });
      expect(d).toContain("$687.50");
      expect(d).toContain("export.csv");
      expect(d).toContain("Close this period");
    });
  }
});
