# Domain Engine

One place for the life of every cold-email sending domain: inventory → provisioning →
warming → active → draining → burned. It handles bulk replacement with full lineage,
health rules on Smartlead data, and inbox settings.

Next.js 16 (App Router, Cache Components) · Postgres (self-hosted Supabase) ·
Leadvance UI kit.

## Local development

No Docker needed. PGlite (Postgres in WASM) runs as the local database.

```bash
npm install
cp .env.example .env.local      # DEV_AUTH_EMAIL skips login locally
npm run db:dev                  # keep running: Postgres on 127.0.0.1:54322
npm run db:migrate
npm run db:seed                 # demo data: 5 clients, ~420 domains, 30 days of stats
npm run dev                     # http://localhost:3000
npm run worker                  # background jobs; "Run now" and the app's follow-up runs wait for it
npm run job -- rollup           # or run one job in this terminal, with no worker running (no name lists them)
```

```bash
npm test          # schema, state machine, replacement and health-rule tests
npm run typecheck
npm run lint
```

## Where things are

| Path | What |
|---|---|
| `supabase/migrations/` | Schema. `transition_domain()` is the only way to change a status; `start_replacement()` pairs domains and records lineage; `evaluate_health_rules()` opens and resolves alerts |
| `src/lib/queries.ts`, `src/lib/*-db.ts` | Reads (the `-db` files hold a feature's own reads) |
| `src/app/api/webhooks/smartlead/[token]` | Smartlead webhook: parses, classifies and stores sent/reply/bounce events |
| `src/integrations/` | Clients for Smartlead, Hypertide, Icemail, the registrars and RDAP/WHOIS (rate limits, retries, dry-run writes) and their response parsers |
| `src/jobs/`, `scripts/worker.ts` | Background jobs and the worker that schedules them |
| `src/app/actions.ts` | All writes (server actions, Zod-validated, audited) |
| `src/components/` | UI: shell and ⌘K, domains table, replace flow, detail panel |
| `src/app/globals.css` | Leadvance tokens (light and dark) and component classes |
| `deploy/` | VPS stacks: trimmed Supabase, the app, and backups. See `DEPLOY.md` |

## Keyboard

`⌘K` search and commands · `G` then a page's letter to jump to it (⌘K shows each
page's letter; they're set in `src/components/shell/nav.ts`).
