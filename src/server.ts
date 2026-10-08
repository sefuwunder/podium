// Podium server: Bun + zero deps + SQLite. Slack-meets-Notion for fractional
// C-suite pods, with time tracking and payroll statements.
// Localhost only — no auth (Deck's TOTP / loopback binding is the boundary).

import {
  initDb, seed, uid,
  listPeople, getPerson, createPerson, updatePerson, deletePerson,
  listPods, getPod, createPod, updatePod, deletePod,
  listMembers, addMember, removeMember, MAX_MEMBERS,
  listChannels, getChannel, createChannel, renameChannel, deleteChannel,
  listMessages, createMessage,
  listPages, getPage, createPage, updatePage, deletePage,
  listEntries, createEntry, updateEntry, deleteEntry, entryLocked, getEntry,
  listPeriods, getPeriod, createPeriod, closePeriod, listStatements, statementsCsv, periodLiveTotals,
  dashboard, weekRange,
} from "./db.ts";

const PORT = Number(process.env.PORT || 3025);

initDb();
seed();

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
}
async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function err(e: any): Response {
  const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
  return json({ error: e?.message || "internal error" }, status);
}
function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "text/javascript";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
const PUB = new URL("../public", import.meta.url).pathname;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const seg = (i: number) => decodeURIComponent(path.split("/")[i] || "");
    try {
      // ----- status -----
      if (path === "/api/status" && method === "GET") {
        return json({ ok: true, people: listPeople().length, pods: listPods().length, maxMembers: MAX_MEMBERS });
      }

      // ----- people -----
      if (path === "/api/people" && method === "GET") return json({ people: listPeople() });
      if (path === "/api/people" && method === "POST") {
        const b = await readBody(req);
        return json({ person: createPerson(b) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "people" && seg(3)) {
        const p = getPerson(seg(3));
        if (!p) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ person: p });
        if (method === "PUT") return json({ person: updatePerson(seg(3), await readBody(req)) });
        if (method === "DELETE") { deletePerson(seg(3)); return json({ ok: true }); }
      }

      // ----- pods -----
      if (path === "/api/pods" && method === "GET") {
        return json({ pods: listPods().map((p) => ({ ...p, members: listMembers(p.id).length })) });
      }
      if (path === "/api/pods" && method === "POST") {
        const b = await readBody(req);
        return json({ pod: createPod(b) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "pods" && seg(3) && !seg(4)) {
        const p = getPod(seg(3));
        if (!p) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ pod: p, members: listMembers(p.id), channels: listChannels(p.id) });
        if (method === "PUT") return json({ pod: updatePod(seg(3), await readBody(req)) });
        if (method === "DELETE") { deletePod(seg(3)); return json({ ok: true }); }
      }

      // ----- pod members -----
      if (seg(1) === "api" && seg(2) === "pods" && seg(4) === "members" && seg(3)) {
        const podId = seg(3);
        if (!getPod(podId)) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ members: listMembers(podId) });
        if (method === "POST") {
          const b = await readBody(req);
          return json({ member: addMember(podId, b.person_id, b.role || "") }, 201);
        }
        if (seg(5) && method === "DELETE") {
          return json({ ok: removeMember(podId, seg(5)) });
        }
      }

      // ----- pod channels -----
      if (seg(1) === "api" && seg(2) === "pods" && seg(4) === "channels" && seg(3)) {
        const podId = seg(3);
        if (!getPod(podId)) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ channels: listChannels(podId) });
        if (method === "POST") {
          const b = await readBody(req);
          return json({ channel: createChannel(podId, b.name || "general") }, 201);
        }
      }
      if (seg(1) === "api" && seg(2) === "channels" && seg(3) && !seg(4)) {
        const c = getChannel(seg(3));
        if (!c) return json({ error: "not found" }, 404);
        if (method === "PUT") return json({ channel: renameChannel(seg(3), (await readBody(req)).name || "") });
        if (method === "DELETE") { deleteChannel(seg(3)); return json({ ok: true }); }
      }

      // ----- channel messages -----
      if (seg(1) === "api" && seg(2) === "channels" && seg(4) === "messages" && seg(3)) {
        const c = getChannel(seg(3));
        if (!c) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ messages: listMessages(c.id) });
        if (method === "POST") {
          const b = await readBody(req);
          const m = createMessage({ pod_id: c.pod_id, channel_id: c.id, author_id: b.author_id, body_md: b.body_md, thread_parent_id: b.thread_parent_id || null });
          return json({ message: m }, 201);
        }
      }

      // ----- pages -----
      if (seg(1) === "api" && seg(2) === "pods" && seg(4) === "pages" && seg(3)) {
        const podId = seg(3);
        if (!getPod(podId)) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ pages: listPages(podId) });
        if (method === "POST") {
          const b = await readBody(req);
          return json({ page: createPage(podId, b) }, 201);
        }
      }
      if (seg(1) === "api" && seg(2) === "pages" && seg(3)) {
        const pg = getPage(seg(3));
        if (!pg) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ page: pg });
        if (method === "PUT") return json({ page: updatePage(seg(3), await readBody(req)) });
        if (method === "DELETE") { deletePage(seg(3)); return json({ ok: true }); }
      }

      // ----- time entries -----
      if (path === "/api/time" && method === "GET") {
        const q = url.searchParams;
        let from = q.get("from") || undefined, to = q.get("to") || undefined;
        const week = q.get("week");
        if (week) { const r = weekRange(week); from = r.from; to = r.to; }
        return json({
          entries: listEntries({
            person_id: q.get("person_id") || undefined,
            pod_id: q.get("pod_id") || undefined, from, to,
            period_id: q.get("period_id") || undefined,
          }),
        });
      }
      if (path === "/api/time" && method === "POST") {
        const b = await readBody(req);
        return json({ entry: createEntry(b) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "time" && seg(3)) {
        if (method === "PUT") {
          const e = updateEntry(seg(3), await readBody(req));
          if (!e) return json({ error: "not found" }, 404);
          return json({ entry: e });
        }
        if (method === "DELETE") {
          if (!deleteEntry(seg(3))) return json({ error: "not found" }, 404);
          return json({ ok: true });
        }
        if (method === "GET") {
          const e = getEntry(seg(3));
          if (!e) return json({ error: "not found" }, 404);
          return json({ entry: e, locked: entryLocked(seg(3)) });
        }
      }

      // ----- pay periods -----
      if (path === "/api/periods" && method === "GET") return json({ periods: listPeriods() });
      if (path === "/api/periods" && method === "POST") {
        const b = await readBody(req);
        return json({ period: createPeriod(b) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "periods" && seg(3) && !seg(4)) {
        const p = getPeriod(seg(3));
        if (!p) return json({ error: "not found" }, 404);
        const out: any = { period: p, statements: listStatements(p.id) };
        if (p.status === "open") out.live = periodLiveTotals(p.id); // review-before-close
        if (method === "GET") return json(out);
      }
      if (seg(1) === "api" && seg(2) === "periods" && seg(4) === "close" && seg(3) && method === "POST") {
        const r = closePeriod(seg(3));
        return json({ period: r.period, statements: r.statements });
      }
      if (seg(1) === "api" && seg(2) === "periods" && seg(4) === "export.csv" && seg(3) && method === "GET") {
        const p = getPeriod(seg(3));
        if (!p) return json({ error: "not found" }, 404);
        return new Response(statementsCsv(p.id), {
          headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="payroll-${p.label.replace(/[^\w-]+/g, "_")}.csv"` },
        });
      }

      // ----- dashboard -----
      if (path === "/api/dashboard" && method === "GET") return json(dashboard());

      // ----- static -----
      if (!path.startsWith("/api/")) {
        let f = path === "/" ? "/index.html" : path;
        if (f.includes("..")) return new Response("bad path", { status: 400 });
        const file = Bun.file(PUB + f);
        if (await file.exists()) return new Response(file, { headers: { "Content-Type": contentType(f) } });
        const idx = Bun.file(PUB + "/index.html");
        return new Response(idx, { headers: { "Content-Type": "text/html" } });
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return err(e);
    }
  },
});

console.log(`podium on http://127.0.0.1:${PORT}`);
