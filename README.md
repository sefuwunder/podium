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

- **Pods** — max 9 members each ("<10", enforced server-side). Each pod auto-creates a `#general` channel.
- **Chat** — per-pod channels, one level of threading, tiny built-in markdown renderer.
- **Pages** — Notion-style wiki per pod, with live-preview editor.
- **Time** — weekly grid (days × pods) per person; entries validated (0 < hours ≤ 24, person must be a pod member).
- **Payroll** — open a period, close it to snapshot per-person × per-pod statements (hours × rate at close). Entries in closed periods are read-only (403). Export CSV for your payroll provider.

### Payroll scope — a judgment call

Podium does **calculation + statements + CSV export**. No money moves through Podium, and it never will from this codebase: self-hosted disbursement (ACH/wires/payouts) would be irresponsible to fake. Take the CSV to your payroll provider.

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
| `GET /api/dashboard` | this week's hours per pod + open-period totals per person |

## Tests

```sh
bun test
```

Covers: 9-member cap, time-entry validation, payroll math across pods, close locks entries (403), statement snapshots, CSV shape, single-open-period rule — plus a DOM-stubbed render smoke test of the main views.

## Seed data

First boot seeds 2 pods ("Acme Foods" — 4 execs; "Brightline" — 3 execs, one shared), channels with threaded messages, wiki pages, this week's time entries, and one open pay period.
