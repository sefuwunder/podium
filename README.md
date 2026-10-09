# Podium

Management for sets of fractional C-suite pods. Slack meets Notion, with time tracking & payroll — for intimate groups under 10.

A fractional-exec firm runs several **pods**; each pod is a small team of fractional execs serving one client company. One exec can belong to multiple pods. The firm owner sees everything.

## Run

```sh
bun src/server.ts
```

- Port **3025** by default (`PORT` env wins — Deck injects it).
- Binds `127.0.0.1` only.
- All data in gitignored `./data/podium.db` (override with `PODIUM_DATA`).
- Zero npm dependencies. No build step.

## What it does

- **Pods** — max 9 members each ("<10", enforced server-side). Each pod auto-creates a `#general` channel. Billing per pod: hourly (default) or monthly retainer with an hours cap.
- **Chat** — per-pod channels, one level of threading, tiny built-in markdown renderer.
- **Pages** — Notion-style wiki per pod, with live-preview editor and "New from template" (SOW, meeting notes, 30-60-90 roadmap, deliverables tracker — all with `{{variable}}` substitution, editable in Settings).
- **Time** — weekly grid (days × pods) per person; entries validated (0 < hours ≤ 24, person must be a pod member). **Big green button**: one-tap timer per person, rounds up to 0.1h billing increments on stop.
- **Payroll** — open a period, close it to snapshot per-person × per-pod statements (hours × rate at close). Entries in closed periods are read-only (403). Export CSV for your payroll provider.
- **Pipeline (CRM)** — kanban across Intro Call → Diagnostic Pitch → SOW Sent → Closed Won (+ Lost, terminal). Top-20 warm/hot view, VC/accelerator partner directory, weighted pipeline values. **Closed Won → "Spin up pod"** is the money loop.
- **Scheduling** — per-person availability, public booking pages (`/book/:slug`) with free 30-min slots, firm schedule view; bookings link to leads.
- **Invoices** — generate from billable hours (hourly pods) or the flat retainer rate; draft → sent → paid → void; QBO/Xero-shaped CSV export.
- **Stripe** — test mode by default; sync monthly retainer subscriptions; send invoices through Stripe with hosted payment pages; `invoice.paid` webhook marks ours paid (signature-verified).
- **Slack** — provision a private `pod-<slug>` channel per pod, invite members by email, plus calm notifications (timer start/stop, invoice sent/paid, deal won).
- **QuickBooks Online** — OAuth connect, push invoices (customer find-or-create). Until connected, the CSV export is the bridge.
- **ClickUp** — link a ClickUp list per pod; the pod's Tasks tab lists tasks (status, due, assignees, deep link), creates tasks, and closes them (resolves the list's done/closed status first). Token verified in Settings.
- **Mailbox (IMAP)** — each pod's Inbox tab shows the latest email thread with every member, read-only (never marks mail seen), cached 5 minutes with manual refresh. Uses the same zero-dep IMAP client as Relay (`src/imap.ts`, copied verbatim).

### Payroll scope — a judgment call

Podium does **calculation + statements + CSV export**. No money moves through Podium, and it never will from this codebase: self-hosted disbursement (ACH/wires/payouts) would be irresponsible to fake. Take the CSV to your payroll provider.

### Integration judgment calls

- **QuickBooks Online over Xero** for v1 (US firm; Xero can come later).
- **Stripe defaults to test mode.** Real money moves only with a live secret key and the mode flipped to Live.
- **QBO OAuth is fully coded** but requires creating an Intuit app and connecting in Settings — until then, CSV export is the bridge.
- **Stage machine**: deals move forward exactly one step; `lost` is reachable from anywhere; `won` and `lost` are terminal.
- **Secrets** (Stripe keys, Slack token, QBO secrets, ClickUp token, IMAP password) live in the server-side `settings` table only. `GET /api/settings` masks them; they never appear in client JS, logs, or the repo.
- **No external calendar sync** (Google/Outlook) in v1 — noted as future work.
- **No inbound Slack mirroring** in v1 — outbound notifications + channel provisioning only.
- **No background IMAP polling** in v1 — the Inbox tab fetches on open + manual refresh; the 5-minute cache keeps it from hammering the mail server.
- **No ClickUp webhooks** in v1 — tasks refresh on tab open.

## API

REST JSON under `/api/*`:

| Method & path | Notes |
|---|---|
| `GET/POST /api/people`, `PUT/DELETE /api/people/:id` | `hourly_rate_cents` (integer) |
| `GET/POST /api/pods`, `GET/PUT/DELETE /api/pods/:id` | auto-creates `#general` |
| `GET/POST /api/pods/:id/members`, `DELETE /api/pods/:id/members/:person_id` | 9-cap → 409 |
| `GET/POST /api/pods/:id/channels`, `PUT/DELETE /api/channels/:id` | |
| `GET/POST /api/channels/:id/messages` | `thread_parent_id` for one-level threads |
| `GET/POST /api/pods/:id/pages`, `GET/PUT/DELETE /api/pages/:id` | |
| `GET /api/time?person_id&pod_id&week&from&to&period_id`, `POST /api/time`, `PUT/DELETE /api/time/:id` | closed-period edits → 403 |
| `GET/POST /api/periods`, `POST /api/periods/:id/close` | one open period at a time → 409 |
| `GET /api/periods/:id/export.csv` | `person,pod,hours,rate_cents,amount_cents` |
| `GET /api/dashboard` | this week's hours per pod + open-period totals per person + retainer usage + running timers |
| `GET/POST /api/leads`, `GET /api/leads/top20`, `GET/PUT/DELETE /api/leads/:id` | `temperature` hot/warm/cold, `priority` 1–5, `value_cents` |
| `POST /api/leads/:id/move` | `{stage}` — forward one step or to `lost`; won/lost terminal |
| `POST /api/leads/:id/spin-up-pod` | won deal → new pod, sets `lead.pod_id` |
| `GET /api/pipeline` | kanban summary: counts, totals, weighted values |
| `GET/POST /api/partners`, `PUT/DELETE /api/partners/:id` | VC/accelerator/other directory |
| `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id` | `{{variable}}` page templates |
| `POST /api/pods/:id/pages/from-template` | `{template_id, variables, title?}` → wiki page |
| `POST /api/timer/start`, `POST /api/timer/stop`, `GET /api/timer/status` | one active timer per person; stop rounds up to 0.1h |
| `GET/PUT /api/pods/:id/retainer` | `{billing_type, retainer_hours, retainer_rate_cents}` + month-to-date usage |
| `GET/POST /api/availability`, `DELETE /api/availability/:id` | per-person weekly availability |
| `GET/POST /api/bookings`, `DELETE /api/bookings/:id`, `POST /api/bookings/:id/link-lead` | firm-side bookings |
| `POST /api/people/:id/enable-booking` | generates the public `/book/:slug` |
| `GET /book/:slug`, `GET /book/:slug/slots`, `POST /book/:slug` | public booking page (no auth) |
| `POST /api/invoices/generate`, `GET /api/invoices`, `GET /api/invoices/:id` | draft invoices, `INV-YYYY-NNN` numbering |
| `POST /api/invoices/:id/send`, `POST /api/invoices/:id/void` | send via Stripe if connected, else mark sent |
| `GET /api/invoices/export.csv` | QBO/Xero-shaped fallback |
| `GET /api/settings`, `POST /api/settings` | secrets masked on read |
| `POST /api/integrations/stripe/sync-retainers` | Stripe customers + monthly subscriptions for retainer pods |
| `POST /api/integrations/stripe/webhook` | `invoice.paid` → ours paid (signature-verified) |
| `POST /api/integrations/slack/provision-channel` | private `pod-<slug>` channel + member invites + intro post |
| `POST /api/integrations/slack/test` | hello-world to verify the token |
| `GET /api/integrations/qbo/auth-url`, `GET /api/integrations/qbo/callback` | Intuit OAuth |
| `POST /api/integrations/qbo/push-invoice/:id` | find-or-create customer, post invoice |
| `POST /api/integrations/clickup/test` | verifies the personal token (`GET /user`) |
| `PUT /api/pods/:id/clickup-list` | `{list_id}` — link a ClickUp list to the pod |
| `GET/POST /api/pods/:id/tasks` | list / create tasks in the linked list |
| `POST /api/pods/:id/tasks/:taskId/close` | resolves the list's done status, moves the task |
| `POST /api/integrations/imap/test` | `validateImap` login check |
| `GET /api/pods/:id/inbox` | latest thread per member (5-min cache) |
| `POST /api/pods/:id/inbox/refresh` | clear cache + re-fetch |
| `GET /api/pods/:id/inbox/:uid/body` | full body for one message |

## Tests

```sh
bun test                          # api.test.ts + ui.test.ts (existing suite)
bun test ./tests/integrations-check.ts   # v1 integrations (36 tests)
```

Covers: 9-member cap, time-entry validation, payroll math across pods, close locks entries (403), statement snapshots, CSV shape, single-open-period rule — plus a DOM-stubbed render smoke test of the main views.

Integrations: lead stage machine, spin-up-pod money loop, Top-20 ordering, template substitution, timer rounding (0.1h), retainer usage, booking slots/double-book/availability, invoice math (hourly + flat retainer) and numbering, Stripe send/sync/webhook with mocked fetch, Slack provision/invites with mocked fetch, QBO push payload with mocked fetch, settings secret masking — plus render smoke tests of every new view.

## Seed data

First boot seeds 2 pods ("Acme Foods" — 4 execs; "Brightline" — 3 execs, one shared), channels with threaded messages, wiki pages, this week's time entries, and one open pay period.
