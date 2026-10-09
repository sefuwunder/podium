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
- **Talent** — exec skill matrix + capacity dashboard: per-exec monthly cap (max weekly hours × 4.33), allocated hours across pods, load bars (green <70%, amber 70–95%, red >95%), skill filter, conflict-of-interest badges. People carry skills, rate tier (I/II/III or $/$$/$$$), and an optional bio.
- **Pod builder** — enter a client company, required skills, and target monthly hours; execs are ranked (+2 per matching skill, +1 when the hours fit their free capacity; conflicted execs are excluded outright). One-click "Create pod" spins up `<Company> Pod` with per-exec monthly allocations.
- **Client match portal** — per-pod public link (`/match/:slug`, anonymized: first name + last initial, title, skill tags, rate band, bio — no emails, full names, or dollar rates). Enable/revoke from the pod view; revoked or invisible slugs 404.
- **Public intake** — standalone `/intake` page (no sidebar): name, company, email, phone, needs, budget band, contact method → creates a lead in `intro` stage with `source='intake'`, visible in the normal Pipeline. Light IP rate limiting (10/hour, in-memory); no CAPTCHA in v1.
- **Objectives** — per-pod OKR/milestone dashboard: objectives with progress bars, key results, inline progress + status updates, add forms. Demo pods ship with a seeded example.
- **Value log** — time entries carry a block type (`hours` / `advisory` / `sprint` / `milestone`) plus freeform "key decisions / assets" bullets. The Time tab toggles between Timesheet and Value log (entries grouped by week with block pills and decision bullets — the value-delivered narrative the client sees). Timer stop asks for block type + decisions; both editable afterward. Payroll/invoice math still sums plain hours.
- **Scope-drift alerts** — when a time entry lands on a retainer pod, usage is recomputed; first crossing of 80% / 100% of the cap creates an in-app alert (one per pod per month per kind) with an "Adjust retainer" deep link to the pod's billing section. Firm header bell with unread badge; Slack post to the pod's channel when connected.
- **SOW e-signing (built-in)** — any wiki page can be sent for signature: enter signer name/email → token link `/sign/:token` shows the rendered SOW; the client types their name and signs. `signature_hash` = SHA-256 hex of (page body + signer name + email + timestamp). Page shows a Pending/Signed banner with hash prefix; revoking deletes the ceremony (links 404).

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

### Talent judgment calls

- **Allocation rule**: explicit `allocated_hours` per membership wins; otherwise an even split of the pod's retainer cap; hourly pods contribute 0 unless set explicitly. Capacity is computed on request — no background jobs.
- **Conflict exclusion, not penalty**: an exec conflicted with the client company is dropped from builder suggestions outright (cleaner than a −10 score).
- **Rate tier is shown, never scored** — the builder ranks on skills + capacity fit only.
- **Match portal anonymization is enforced server-side** (`matchPortalData` builds fresh objects — no email/full-name fields exist to leak), and the public `/match/:slug` page 404s on revoked/invisible slugs.
- **The client-need blurb** (`match_blurb`) is firm-written marketing copy shown on the match page — editable when the link is enabled.

### Client-portal judgment calls

- **Built-in e-signing instead of DocuSign for v1**: a typed-name ceremony with a SHA-256 hash binding (page body + signer + email + timestamp) is verifiable today with no third-party account, no per-envelope fees, and zero new dependencies. DocuSign remains the enterprise upgrade path (audit trail, identity verification, legal enforceability tooling) — the `page_signings` table is shaped to migrate.
- **Timer-stop asks for block metadata**: stopping the timer opens an inline confirm (block type + decisions) rather than silently defaulting — the value log is only useful if the data is captured at the moment, and both fields stay editable afterward.
- **Alerts are in-app + Slack only in v1**: no emails are sent. Email notifications (digest of unseen alerts) are noted as future work.
- **Alert dedupe is per pod per month per kind**: crossing 80% twice in a month fires once; the 100% alert is separate. The message links straight to the pod's Time tab where the retainer bar lives ("Adjust retainer").
- **Value log groups by week, last 4 weeks**: the Timesheet stays a single week; flipping to Value log widens to 4 weeks so the narrative has room to breathe.
- **Intake rate limit is in-memory** (10/hour/IP): restarts clear it; good enough for v1 spam hygiene alongside the required-field validation.

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
bun test                          # full suite
```

Covers: 9-member cap, time-entry validation, payroll math across pods, close locks entries (403), statement snapshots, CSV shape, single-open-period rule — plus a DOM-stubbed render smoke test of the main views.

Integrations: lead stage machine, spin-up-pod money loop, Top-20 ordering, template substitution, timer rounding (0.1h), retainer usage, booking slots/double-book/availability, invoice math (hourly + flat retainer) and numbering, Stripe send/sync/webhook with mocked fetch, Slack provision/invites with mocked fetch, QBO push payload with mocked fetch, settings secret masking — plus render smoke tests of every new view.

Talent (`tests/talent-check.test.ts`, 21 tests): person skill/tier/bio fields + validation, conflicts CRUD, capacity math (explicit hours, retainer even-split fallback, hourly = 0, unlimited cap), builder scoring (+2/skill, +1 capacity fit), conflict exclusion, builder pod creation (naming, members, hours, validation), match portal (enable/revoke, anonymization of HTML + JSON — no email/full-name leaks, 404s for bogus and revoked slugs), and DOM-stubbed renders of the Talent/Builder/match-portal views.

Client portal & value-log (`tests/client-portal-check.test.ts`, 34 tests): intake validation + budget-band whitelist + IP rate limit + pipeline visibility, objectives/KR CRUD + validation + cascade delete + seeded examples, block_type/decisions on entries (create/edit/timer-stop) + invalid-type rejection, alert crossing (79→81 fires once, 85% silent, 100% fires) + unseen filter + mark-seen + Slack post via mocked fetch, full signing ceremony (token entropy, pending→signed, SHA-256 hash recomputation, double-sign 409, revoke → 404), public `/intake` + `/sign/:token` pages, and DOM-stubbed renders of Objectives/Alerts/Value-log/Signing-banner plus stylesheet checks.

## Seed data

First boot seeds 2 pods ("Acme Foods" — 4 execs; "Brightline" — 3 execs, one shared), channels with threaded messages, wiki pages, this week's time entries, one open pay period, and one example objective per pod (with key results).
