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
  // v1 integrations
  getSetting, setSetting, publicSettings, activeStripeSecret, stripeMode, KNOWN_SETTINGS,
  listPartners, getPartner, createPartner, updatePartner, deletePartner,
  listLeads, getLead, createLead, updateLead, deleteLead, moveLead, spinUpPod, topLeads, pipelineSummary,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, pageFromTemplate,
  startTimer, stopTimer, activeTimerFor, activeTimers,
  updatePodBilling, retainerUsage,
  listAvailability, setAvailability, deleteAvailability, enableBookingSlug,
  listBookings, getBooking, createBooking, publicBook, cancelBooking, linkBookingLead, freeSlots,
  listInvoices, getInvoice, generateInvoice, sendInvoice, voidInvoice, markInvoicePaid, getInvoiceByStripeId, invoicesCsv,
  setPodStripeIds, setPodStripeCustomer, setPodSlackChannel, setInvoiceQboId,
} from "./db.ts";
import {
  stripeCreateCustomer, stripeCreatePrice, stripeCreateSubscription,
  stripeCreateInvoiceItem, stripeCreateInvoice, stripeFinalizeInvoice,
  verifyStripeWebhook,
  slackCreateChannel, slackListChannels, slackLookupUser, slackInvite, slackPost,
  qboAuthUrl, qboExchangeCode, qboRefresh, qboBaseUrl, qboReq, buildQboInvoice,
} from "./integrations.ts";

const PORT = Number(process.env.PORT || 3025);

initDb();
seed();

/** Mock integration network calls in tests (PODIUM_MOCK_INTEGRATIONS=1).
 *  Records every outbound call; inspect via GET /api/_mock/calls. */
const MOCK = process.env.PODIUM_MOCK_INTEGRATIONS === "1";
const mockCalls: any[] = [];
let mockSlackCreateMode = "ok";
if (MOCK) {
  (globalThis as any).__podiumFetch = async (url: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const ct = headers["Content-Type"] || headers["content-type"] || "";
    let params: any = init.body;
    if (typeof init.body === "string") {
      if (ct.includes("urlencoded")) params = Object.fromEntries(new URLSearchParams(init.body));
      else { try { params = JSON.parse(init.body); } catch { /* keep raw */ } }
    }
    mockCalls.push({ url, method, params });
    const ok = (j: any, status = 200) =>
      new Response(JSON.stringify(j), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("api.stripe.com")) {
      if (url.endsWith("/customers")) return ok({ id: "cus_mock1" });
      if (url.endsWith("/prices")) return ok({ id: "price_mock1" });
      if (url.endsWith("/subscriptions")) return ok({ id: "sub_mock1" });
      if (url.endsWith("/invoiceitems")) return ok({ id: "ii_mock1" });
      if (/\/invoices\/[^/]+\/finalize/.test(url)) return ok({ id: "in_mock1", hosted_invoice_url: "https://pay.stripe.com/mock1" });
      if (url.endsWith("/invoices")) return ok({ id: "in_mock1" });
      return ok({});
    }
    if (url.includes("slack.com/api/")) {
      const m = url.split("slack.com/api/")[1];
      if (m === "conversations.create") {
        if (mockSlackCreateMode === "name_taken") return ok({ ok: false, error: "name_taken" });
        return ok({ ok: true, channel: { id: "C123", name: params?.name } });
      }
      if (m === "conversations.list") return ok({ ok: true, channels: [{ id: "C999", name: params ? undefined : "pod-x" }, { id: "C999", name: "pod-acme-foods" }] });
      if (m === "users.lookupByEmail")
        return ok({ ok: true, user: { id: "U_" + String(params?.email || "").split("@")[0].replace(/[^a-z0-9]/gi, "") } });
      if (m === "conversations.invite") return ok({ ok: true });
      if (m === "chat.postMessage") return ok({ ok: true, ts: "1.0" });
      return ok({ ok: true });
    }
    if (url.includes("oauth.platform.intuit.com")) {
      return ok({ access_token: "at_mock", refresh_token: "rt_mock", expires_in: 3600 });
    }
    if (url.includes("quickbooks.api.intuit.com")) {
      if (url.includes("/query")) return ok({ QueryResponse: {} });
      if (url.includes("/customer")) return ok({ Customer: { Id: "9001" } });
      if (url.includes("/invoice")) return ok({ Invoice: { Id: "7001", DocNumber: "7001" } });
      return ok({});
    }
    return ok({});
  };
}

/** Best-effort Slack notification — never breaks the request. */
async function notifySlack(podId: string | null, text: string): Promise<void> {
  try {
    if (!podId) return;
    const token = getSetting("slack_bot_token");
    const pod = getPod(podId);
    if (!token || !pod?.slack_channel_id) return;
    await slackPost(token, pod.slack_channel_id, text);
  } catch { /* notifications are fire-and-forget */ }
}
const moneyStr = (cents: number) => "$" + (Number(cents) / 100).toFixed(2);

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
      if (seg(1) === "api" && seg(2) === "people" && seg(4) === "enable-booking" && seg(3) && method === "POST") {
        return json({ slug: enableBookingSlug(seg(3)) });
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
        if (method === "GET") return json({
          pod: p, members: listMembers(p.id), channels: listChannels(p.id),
          retainer: retainerUsage(p.id),
          timers: activeTimers().filter((t) => t.pod_id === p.id),
        });
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
      if (seg(1) === "api" && seg(2) === "pods" && seg(4) === "pages" && seg(5) === "from-template" && seg(3) && method === "POST") {
        const b = await readBody(req);
        return json({ page: pageFromTemplate(seg(3), b.template_id, b.variables || {}, b.title) }, 201);
      }
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

      // ----- CRM: partners -----
      if (path === "/api/partners" && method === "GET") return json({ partners: listPartners() });
      if (path === "/api/partners" && method === "POST") {
        return json({ partner: createPartner(await readBody(req)) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "partners" && seg(3)) {
        const pt = getPartner(seg(3));
        if (!pt) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ partner: pt });
        if (method === "PUT") return json({ partner: updatePartner(seg(3), await readBody(req)) });
        if (method === "DELETE") { deletePartner(seg(3)); return json({ ok: true }); }
      }

      // ----- CRM: leads & pipeline -----
      if (path === "/api/leads" && method === "GET") {
        const q = url.searchParams;
        return json({ leads: listLeads({ stage: q.get("stage") || undefined, temperature: q.get("temperature") || undefined }) });
      }
      if (path === "/api/leads/top20" && method === "GET") return json({ leads: topLeads() });
      if (path === "/api/leads" && method === "POST") {
        return json({ lead: createLead(await readBody(req)) }, 201);
      }
      if (path === "/api/pipeline" && method === "GET") return json({ stages: pipelineSummary() });
      if (seg(1) === "api" && seg(2) === "leads" && seg(4) === "move" && seg(3) && method === "POST") {
        const before = getLead(seg(3));
        const lead = moveLead(seg(3), (await readBody(req)).stage);
        if (before && before.stage !== "won" && lead.stage === "won" && lead.pod_id)
          notifySlack(lead.pod_id, `Won: ${lead.company || lead.name}.`);
        return json({ lead });
      }
      if (seg(1) === "api" && seg(2) === "leads" && seg(4) === "spin-up-pod" && seg(3) && method === "POST") {
        const { lead, pod } = spinUpPod(seg(3));
        notifySlack(pod.id, `Kicked off from a won deal: ${lead.company || lead.name}.`);
        return json({ lead, pod }, 201);
      }
      if (seg(1) === "api" && seg(2) === "leads" && seg(3) && !seg(4)) {
        const l = getLead(seg(3));
        if (!l) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ lead: l });
        if (method === "PUT") return json({ lead: updateLead(seg(3), await readBody(req)) });
        if (method === "DELETE") { deleteLead(seg(3)); return json({ ok: true }); }
      }

      // ----- templates -----
      if (path === "/api/templates" && method === "GET") return json({ templates: listTemplates() });
      if (path === "/api/templates" && method === "POST") {
        return json({ template: createTemplate(await readBody(req)) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "templates" && seg(3)) {
        const t = getTemplate(seg(3));
        if (!t) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ template: t });
        if (method === "PUT") return json({ template: updateTemplate(seg(3), await readBody(req)) });
        if (method === "DELETE") { deleteTemplate(seg(3)); return json({ ok: true }); }
      }

      // ----- timer: the big green button -----
      if (path === "/api/timer/start" && method === "POST") {
        const t = startTimer(await readBody(req));
        const person = getPerson(t.person_id), pod = getPod(t.pod_id);
        notifySlack(t.pod_id, `${person?.name || "Someone"} started tracking time on ${pod?.name || "a pod"}.`);
        return json({ timer: t }, 201);
      }
      if (path === "/api/timer/stop" && method === "POST") {
        const r = stopTimer((await readBody(req)).person_id);
        const person = getPerson(r.timer.person_id), pod = getPod(r.timer.pod_id);
        notifySlack(r.timer.pod_id, `${person?.name || "Someone"} logged ${r.hours}h on ${pod?.name || "a pod"}${r.timer.note ? ` — ${r.timer.note}` : ""}.`);
        return json(r);
      }
      if (path === "/api/timer/status" && method === "GET") {
        const withElapsed = (t: any) => ({ ...t, elapsed_sec: Math.max(0, Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000)) });
        const pid = url.searchParams.get("person_id");
        if (pid) {
          const t = activeTimerFor(pid);
          return json({ timer: t ? withElapsed(t) : null });
        }
        return json({ timers: activeTimers().map(withElapsed) });
      }

      // ----- pod billing / retainer -----
      if (seg(1) === "api" && seg(2) === "pods" && seg(4) === "retainer" && seg(3)) {
        if (!getPod(seg(3))) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ pod: getPod(seg(3)), retainer: retainerUsage(seg(3)) });
        if (method === "PUT") return json({ pod: updatePodBilling(seg(3), await readBody(req)) });
      }

      // ----- availability -----
      if (path === "/api/availability" && method === "GET") {
        const pid = url.searchParams.get("person_id");
        if (!pid) return json({ error: "person_id required" }, 400);
        return json({ availability: listAvailability(pid) });
      }
      if (path === "/api/availability" && method === "POST") {
        return json({ availability: setAvailability(await readBody(req)) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "availability" && seg(3) && method === "DELETE") {
        return json({ ok: deleteAvailability(seg(3)) });
      }

      // ----- bookings -----
      if (path === "/api/bookings" && method === "GET") {
        const q = url.searchParams;
        return json({ bookings: listBookings({ person_id: q.get("person_id") || undefined, from: q.get("from") || undefined }) });
      }
      if (path === "/api/bookings" && method === "POST") {
        return json({ booking: createBooking(await readBody(req)) }, 201);
      }
      if (seg(1) === "api" && seg(2) === "bookings" && seg(4) === "link-lead" && seg(3) && method === "POST") {
        const b = await readBody(req);
        const bk = linkBookingLead(seg(3), b.lead_id || null);
        if (!bk) return json({ error: "not found" }, 404);
        return json({ booking: bk });
      }
      if (seg(1) === "api" && seg(2) === "bookings" && seg(3) && !seg(4)) {
        const b = getBooking(seg(3));
        if (!b) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ booking: b });
        if (method === "DELETE") { cancelBooking(seg(3)); return json({ ok: true }); }
      }

      // ----- public booking pages -----
      if (seg(1) === "book" && seg(2)) {
        if (seg(3) === "slots" && method === "GET") {
          const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 14));
          const r = freeSlots(seg(2), days);
          return json({ person: { name: r.person.name, title: r.person.title }, slots: r.slots });
        }
        if (!seg(3) && method === "GET") {
          const file = Bun.file(PUB + "/book.html");
          if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
          return json({ error: "not found" }, 404);
        }
        if (!seg(3) && method === "POST") {
          return json({ booking: publicBook(seg(2), await readBody(req)) }, 201);
        }
      }

      // ----- invoices -----
      if (path === "/api/invoices/generate" && method === "POST") {
        return json({ invoice: generateInvoice(await readBody(req)) }, 201);
      }
      if (path === "/api/invoices" && method === "GET") return json({ invoices: listInvoices() });
      if (path === "/api/invoices/export.csv" && method === "GET") {
        return new Response(invoicesCsv(), {
          headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="invoices-qbo.csv"' },
        });
      }
      if (seg(1) === "api" && seg(2) === "invoices" && seg(4) === "send" && seg(3) && method === "POST") {
        const inv = getInvoice(seg(3));
        if (!inv) return json({ error: "not found" }, 404);
        const secret = activeStripeSecret();
        let stripe: { invoice_id: string } | undefined;
        let hosted_url: string | null = null;
        if (secret) {
          const pod = getPod(inv.pod_id);
          if (!pod) return json({ error: "pod not found" }, 404);
          let customerId = pod.stripe_customer_id;
          if (!customerId) {
            const c = await stripeCreateCustomer(secret, { name: pod.client_name || pod.name });
            customerId = c.id;
            setPodStripeCustomer(pod.id, customerId);
          }
          for (const l of inv.line_items) {
            await stripeCreateInvoiceItem(secret, {
              customer: customerId,
              amount_cents: Math.round(l.amount_cents),
              description: l.description || `${l.person_name || "Services"} — ${l.hours || 0}h`,
            });
          }
          const si = await stripeCreateInvoice(secret, {
            customer: customerId,
            metadata: { podium_invoice_id: inv.id, podium_number: inv.number },
          });
          const fin = await stripeFinalizeInvoice(secret, si.id);
          stripe = { invoice_id: fin.id };
          hosted_url = fin.hosted_invoice_url || null;
        }
        const sent = sendInvoice(inv.id, stripe);
        notifySlack(inv.pod_id, `Invoice ${sent.number} (${moneyStr(sent.amount_cents)}) sent to ${sent.client_name || sent.pod_name}.`);
        return json({ invoice: sent, hosted_url });
      }
      if (seg(1) === "api" && seg(2) === "invoices" && seg(4) === "void" && seg(3) && method === "POST") {
        return json({ invoice: voidInvoice(seg(3)) });
      }
      if (seg(1) === "api" && seg(2) === "invoices" && seg(3) && !seg(4) && method === "GET") {
        const inv = getInvoice(seg(3));
        if (!inv) return json({ error: "not found" }, 404);
        return json({ invoice: inv });
      }

      // ----- settings -----
      if (path === "/api/settings" && method === "GET") return json({ settings: publicSettings(), stripeMode: stripeMode() });
      if (path === "/api/settings" && (method === "POST" || method === "PUT")) {
        const b = await readBody(req);
        for (const k of KNOWN_SETTINGS) if (b[k] !== undefined) setSetting(k, String(b[k]));
        return json({ settings: publicSettings() });
      }

      // ----- Stripe -----
      if (path === "/api/integrations/stripe/status" && method === "GET") {
        return json({ mode: stripeMode(), connected: !!activeStripeSecret() });
      }
      if (path === "/api/integrations/stripe/sync-retainers" && method === "POST") {
        const secret = activeStripeSecret();
        if (!secret) return json({ error: "Stripe is not connected — add a secret key in Settings" }, 400);
        const synced = [];
        for (const pod of listPods()) {
          if (pod.billing_type !== "retainer" || !pod.retainer_rate_cents || pod.stripe_subscription_id) continue;
          let customerId = pod.stripe_customer_id;
          if (!customerId) {
            const c = await stripeCreateCustomer(secret, { name: pod.client_name || pod.name });
            customerId = c.id;
          }
          const price = await stripeCreatePrice(secret, { amount_cents: pod.retainer_rate_cents, nickname: `${pod.name} — monthly retainer` });
          const sub = await stripeCreateSubscription(secret, { customer: customerId, price: price.id });
          setPodStripeIds(pod.id, customerId, sub.id);
          synced.push({ pod_id: pod.id, customer: customerId, subscription: sub.id });
        }
        return json({ synced });
      }
      if (path === "/api/integrations/stripe/webhook" && method === "POST") {
        const raw = await req.text();
        const sig = req.headers.get("stripe-signature") || "";
        const endpointSecret = getSetting("stripe_webhook_secret");
        if (endpointSecret && !verifyStripeWebhook(raw, sig, endpointSecret))
          return json({ error: "bad signature" }, 400);
        let event: any;
        try { event = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
        if (event.type === "invoice.paid") {
          const obj = event.data?.object || {};
          const ours = (obj.id && getInvoiceByStripeId(obj.id))
            || (obj.metadata?.podium_invoice_id && getInvoice(obj.metadata.podium_invoice_id));
          if (ours && ours.status !== "paid") {
            markInvoicePaid(ours.id);
            notifySlack(ours.pod_id, `Invoice ${ours.number} (${moneyStr(ours.amount_cents)}) paid.`);
          }
        }
        return json({ received: true });
      }

      // ----- Slack -----
      if (path === "/api/integrations/slack/status" && method === "GET") {
        return json({ connected: !!getSetting("slack_bot_token") });
      }
      if (path === "/api/integrations/slack/test" && method === "POST") {
        const b = await readBody(req);
        const token = getSetting("slack_bot_token");
        if (!token) return json({ error: "Slack is not connected — add a bot token in Settings" }, 400);
        let channel = b.channel;
        if (!channel) channel = listPods().find((p) => p.slack_channel_id)?.slack_channel_id;
        if (!channel) return json({ error: "no channel yet — provision a pod channel first, or pass channel" }, 400);
        const r = await slackPost(token, channel, "Hello from Podium — Slack is connected.");
        return json({ ok: true, ts: r.ts });
      }
      if (path === "/api/integrations/slack/provision-channel" && method === "POST") {
        const b = await readBody(req);
        const pod = getPod(b.pod_id);
        if (!pod) return json({ error: "not found" }, 404);
        const token = getSetting("slack_bot_token");
        if (!token) return json({ error: "Slack is not connected — add a bot token in Settings" }, 400);
        const slug = (pod.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pod").slice(0, 60);
        const name = `pod-${slug}`;
        let channelId = pod.slack_channel_id;
        if (!channelId) {
          try {
            const c = await slackCreateChannel(token, name);
            channelId = c.channel.id;
          } catch (e: any) {
            if (e.slackError !== "name_taken") throw e;
            const list = await slackListChannels(token);
            const found = (list.channels || []).find((c: any) => c.name === name);
            if (!found) throw new Error("channel name is taken but could not be found");
            channelId = found.id;
          }
          setPodSlackChannel(pod.id, channelId);
        }
        const invited: string[] = []; const missing: string[] = [];
        for (const m of listMembers(pod.id)) {
          const person = getPerson(m.person_id);
          if (!person?.email) { missing.push(m.person_name || m.person_id); continue; }
          try {
            const u = await slackLookupUser(token, person.email);
            invited.push(u.user.id);
          } catch { missing.push(person.email); }
        }
        if (invited.length) await slackInvite(token, channelId, invited);
        await slackPost(token, channelId, `This is the private channel for the ${pod.name} pod — transparent, async comms between the pod and the client.`);
        return json({ channel_id: channelId, invited: invited.length, missing });
      }

      // ----- QuickBooks Online -----
      if (path === "/api/integrations/qbo/status" && method === "GET") {
        return json({
          connected: !!getSetting("qbo_refresh_token"),
          realm: getSetting("qbo_realm_id") || null,
          sandbox: getSetting("qbo_sandbox") !== "0",
        });
      }
      if (path === "/api/integrations/qbo/auth-url" && method === "GET") {
        const clientId = getSetting("qbo_client_id");
        if (!clientId) return json({ error: "set the QuickBooks client ID in Settings first" }, 400);
        const redirectUri = getSetting("qbo_redirect_uri") || `http://127.0.0.1:${PORT}/api/integrations/qbo/callback`;
        return json({ url: qboAuthUrl({ clientId, redirectUri }) });
      }
      if (path === "/api/integrations/qbo/callback" && method === "GET") {
        const code = url.searchParams.get("code"), realmId = url.searchParams.get("realmId");
        if (!code) return new Response("Missing code — reconnect from Podium Settings.", { status: 400 });
        const redirectUri = getSetting("qbo_redirect_uri") || `http://127.0.0.1:${PORT}/api/integrations/qbo/callback`;
        const tok = await qboExchangeCode({
          clientId: getSetting("qbo_client_id"), clientSecret: getSetting("qbo_client_secret"),
          code, redirectUri,
        });
        if (tok.refresh_token) setSetting("qbo_refresh_token", tok.refresh_token);
        if (realmId) setSetting("qbo_realm_id", realmId);
        return new Response("<p>QuickBooks connected. You can close this tab and return to Podium.</p>", { headers: { "Content-Type": "text/html" } });
      }
      if (seg(1) === "api" && seg(2) === "integrations" && seg(3) === "qbo" && seg(4) === "push-invoice" && seg(5) && method === "POST") {
        const inv = getInvoice(seg(5));
        if (!inv) return json({ error: "not found" }, 404);
        const clientId = getSetting("qbo_client_id"), clientSecret = getSetting("qbo_client_secret");
        const refreshToken = getSetting("qbo_refresh_token"), realmId = getSetting("qbo_realm_id");
        if (!clientId || !refreshToken || !realmId)
          return json({ error: "connect QuickBooks in Settings first" }, 400);
        const tok = await qboRefresh({ clientId, clientSecret, refreshToken });
        if (tok.refresh_token) setSetting("qbo_refresh_token", tok.refresh_token);
        const common = { baseUrl: qboBaseUrl(getSetting("qbo_sandbox") !== "0"), realmId, accessToken: tok.access_token };
        const displayName = inv.client_name || inv.pod_name || "Client";
        let customerId: string | null = null;
        try {
          const q = await qboReq({ ...common, method: "POST", path: "query?minorversion=75", body: `select Id from Customer where DisplayName = '${displayName.replace(/'/g, "\\'")}'` });
          customerId = q?.QueryResponse?.Customer?.[0]?.Id || null;
        } catch { /* fall through to create */ }
        if (!customerId) {
          const c = await qboReq({ ...common, method: "POST", path: "customer?minorversion=75", body: { DisplayName: displayName } });
          customerId = c.Customer.Id;
        }
        const created = await qboReq({ ...common, method: "POST", path: "invoice?minorversion=75", body: buildQboInvoice(inv, customerId!) });
        setInvoiceQboId(inv.id, created.Invoice.Id);
        return json({ invoice: getInvoice(inv.id), qbo_id: created.Invoice.Id });
      }

      // ----- mock introspection (tests only) -----
      if (MOCK && path === "/api/_mock/calls" && method === "GET") return json({ calls: mockCalls });
      if (MOCK && path === "/api/_mock/reset" && method === "POST") { mockCalls.length = 0; mockSlackCreateMode = "ok"; return json({ ok: true }); }
      if (MOCK && path === "/api/_mock/slack" && method === "POST") {
        mockSlackCreateMode = (await readBody(req)).mode || "ok";
        return json({ ok: true });
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
