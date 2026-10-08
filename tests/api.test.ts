// Podium API tests — boots the real server on a test port with a temp data dir.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "podium-test-"));
process.env.PODIUM_DATA = DATA;
process.env.PORT = "32201";
const BASE = "http://127.0.0.1:32201";

async function api(method: string, path: string, body?: any) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* csv/plain */ }
  return { status: r.status, json: j, text };
}

beforeAll(async () => {
  await import("../src/server.ts");
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/status"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("test server did not start");
});

describe("status & seed", () => {
  test("status 200, cap reported", async () => {
    const r = await api("GET", "/api/status");
    expect(r.status).toBe(200);
    expect(r.json.maxMembers).toBe(9);
    expect(r.json.pods).toBe(2); // seeded
  });
  test("new pod auto-creates #general", async () => {
    const r = await api("POST", "/api/pods", { name: "TestPod", client_name: "TestCo", color: "#123456" });
    expect(r.status).toBe(201);
    const ch = await api("GET", `/api/pods/${r.json.pod.id}/channels`);
    expect(ch.json.channels.map((c: any) => c.name)).toContain("general");
  });
});

describe("member cap", () => {
  test("9 members ok, 10th rejected, duplicate rejected", async () => {
    const pod = (await api("POST", "/api/pods", { name: "CapPod" })).json.pod;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await api("POST", "/api/people", { name: `Cap Person ${i}`, hourly_rate_cents: 10000 });
      ids.push(p.json.person.id);
    }
    for (let i = 0; i < 9; i++) {
      const r = await api("POST", `/api/pods/${pod.id}/members`, { person_id: ids[i], role: "Exec" });
      expect(r.status).toBe(201);
    }
    const tenth = await api("POST", `/api/pods/${pod.id}/members`, { person_id: ids[9] });
    expect(tenth.status).toBe(409);
    expect(tenth.json.error).toMatch(/9 members maximum/);
    const dup = await api("POST", `/api/pods/${pod.id}/members`, { person_id: ids[0] });
    expect(dup.status).toBe(409);
  });
});

describe("time entry validation", () => {
  test("0h, 25h, bad day, non-member all rejected", async () => {
    const pod = (await api("POST", "/api/pods", { name: "TimePod" })).json.pod;
    const member = (await api("POST", "/api/people", { name: "Time Member", hourly_rate_cents: 20000 })).json.person;
    const outsider = (await api("POST", "/api/people", { name: "Outsider", hourly_rate_cents: 20000 })).json.person;
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: member.id });
    const base = { person_id: member.id, pod_id: pod.id, day: "2026-10-05", note: "x" };
    expect((await api("POST", "/api/time", { ...base, hours: 0 })).status).toBe(400);
    expect((await api("POST", "/api/time", { ...base, hours: 25 })).status).toBe(400);
    expect((await api("POST", "/api/time", { ...base, hours: 2, day: "Oct 5" })).status).toBe(400);
    expect((await api("POST", "/api/time", { ...base, person_id: outsider.id, hours: 2 })).status).toBe(400);
    const ok = await api("POST", "/api/time", { ...base, hours: 2.5 });
    expect(ok.status).toBe(201);
    expect(ok.json.entry.hours).toBe(2.5);
    // week filter
    const w = await api("GET", "/api/time?week=2026-10-05");
    expect(w.status).toBe(200);
    expect(w.json.entries.some((e: any) => e.id === ok.json.entry.id)).toBe(true);
  });
});

describe("chat & pages", () => {
  test("message + one-level thread; second-level reply rejected", async () => {
    const pods = await api("GET", "/api/pods");
    const pod = pods.json.pods.find((p: any) => p.name === "TestPod");
    const ch = (await api("GET", `/api/pods/${pod.id}/channels`)).json.channels[0];
    const people = await api("GET", "/api/people");
    const author = people.json.people[0].id;
    const m1 = await api("POST", `/api/channels/${ch.id}/messages`, { author_id: author, body_md: "Hello **pod**" });
    expect(m1.status).toBe(201);
    const m2 = await api("POST", `/api/channels/${ch.id}/messages`, { author_id: author, body_md: "reply", thread_parent_id: m1.json.message.id });
    expect(m2.status).toBe(201);
    const m3 = await api("POST", `/api/channels/${ch.id}/messages`, { author_id: author, body_md: "too deep", thread_parent_id: m2.json.message.id });
    expect(m3.status).toBe(400);
    const list = await api("GET", `/api/channels/${ch.id}/messages`);
    const root = list.json.messages.find((m: any) => m.id === m1.json.message.id);
    expect(root.replies.length).toBe(1);
  });
  test("pages CRUD", async () => {
    const pods = await api("GET", "/api/pods");
    const pod = pods.json.pods[0];
    const c = await api("POST", `/api/pods/${pod.id}/pages`, { title: "Test Page", body_md: "# hi", updated_by: "tester" });
    expect(c.status).toBe(201);
    const u = await api("PUT", `/api/pages/${c.json.page.id}`, { title: "Test Page 2" });
    expect(u.json.page.title).toBe("Test Page 2");
    expect((await api("DELETE", `/api/pages/${c.json.page.id}`)).status).toBe(200);
  });
});

describe("payroll", () => {
  test("only one open period at a time", async () => {
    // seed created one open period
    const r = await api("POST", "/api/periods", { label: "Second", start_day: "2026-11-01", end_day: "2026-11-07" });
    expect(r.status).toBe(409);
  });

  test("close writes exact statement snapshots; CSV correct", async () => {
    const periods0 = await api("GET", "/api/periods");
    const open0 = periods0.json.periods.find((p: any) => p.status === "open");
    expect(open0).toBeTruthy();
    const d1 = open0.start_day; // first day of the open range
    const d2iso = (() => { const d = new Date(d1 + "T12:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
    const pod = (await api("POST", "/api/pods", { name: "PayPod", client_name: "PayCo" })).json.pod;
    const pod2 = (await api("POST", "/api/pods", { name: "PayPod2", client_name: "PayCo2" })).json.pod;
    const a = (await api("POST", "/api/people", { name: "Pay Alice", hourly_rate_cents: 10000 })).json.person; // $100/hr
    const b = (await api("POST", "/api/people", { name: "Pay Bob", hourly_rate_cents: 25000 })).json.person;   // $250/hr
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: a.id });
    await api("POST", `/api/pods/${pod.id}/members`, { person_id: b.id });
    await api("POST", `/api/pods/${pod2.id}/members`, { person_id: a.id });
    // inside the open period's range
    const e1 = await api("POST", "/api/time", { person_id: a.id, pod_id: pod.id, day: d1, hours: 2.5, note: "work" });
    const e2 = await api("POST", "/api/time", { person_id: a.id, pod_id: pod2.id, day: d2iso, hours: 4, note: "work" });
    const e3 = await api("POST", "/api/time", { person_id: b.id, pod_id: pod.id, day: d1, hours: 1, note: "work" });
    expect(e1.status).toBe(201);

    const periods = await api("GET", "/api/periods");
    const open = periods.json.periods.find((p: any) => p.status === "open");
    const closed = await api("POST", `/api/periods/${open.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.json.period.status).toBe("closed");

    const stmts: any[] = closed.json.statements;
    const sa = stmts.filter((s) => s.person_id === a.id);
    expect(sa.length).toBe(2); // two pods
    const sa1 = sa.find((s) => s.pod_id === pod.id)!;
    expect(sa1.hours).toBe(2.5);
    expect(sa1.rate_cents).toBe(10000);
    expect(sa1.amount_cents).toBe(25000); // 2.5 * 10000
    const sb = stmts.find((s) => s.person_id === b.id)!;
    expect(sb.amount_cents).toBe(25000); // 1 * 25000

    // closed entries are locked
    expect((await api("PUT", `/api/time/${e1.json.entry.id}`, { hours: 3 })).status).toBe(403);
    expect((await api("DELETE", `/api/time/${e3.json.entry.id}`)).status).toBe(403);

    // CSV
    const csv = await fetch(BASE + `/api/periods/${open.id}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await csv.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("person,pod,hours,rate_cents,amount_cents");
    expect(lines.some((l) => l.includes("Pay Alice") && l.includes("PayPod") && l.includes("25000"))).toBe(true);

    // now a new period can open
    const np = await api("POST", "/api/periods", { label: "Next", start_day: "2026-11-01", end_day: "2026-11-07" });
    expect(np.status).toBe(201);
    // and closing an already-closed period 409s
    expect((await api("POST", `/api/periods/${open.id}/close`)).status).toBe(409);
  });

  test("open period detail includes live preview totals", async () => {
    const periods = await api("GET", "/api/periods");
    const open = periods.json.periods.find((p: any) => p.status === "open");
    const d = await api("GET", `/api/periods/${open.id}`);
    expect(d.status).toBe(200);
    expect(Array.isArray(d.json.live)).toBe(true);
    // live rows carry the same money fields as statements
    for (const r of d.json.live) {
      expect(typeof r.amount_cents).toBe("number");
      expect(r.amount_cents).toBe(Math.round(r.hours * r.rate_cents));
    }
  });

  test("dashboard 200", async () => {
    const r = await api("GET", "/api/dashboard");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.hoursPerPod)).toBe(true);
  });
});
