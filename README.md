# Helpdesk Ticketing

> A helpdesk a company owns: customers open tickets in a portal, agents work a queue with honest SLA clocks, and AI
> triages tickets and drafts replies from the knowledge base, with an agent always pressing Send.

**Live:** https://app11.breakthruventures.ai · **Runs on:** Google Cloud · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What this app does

SaaS companies, e-commerce shops and IT service providers ask for "a Zendesk we own". They care about three things:
two portals with a hard wall (customers see only their own tickets and never internal notes), SLA timers that are
honest (paused while waiting on the customer, breaches recorded), and AI that helps agents without ever writing to a
customer on its own.

- **Anyone** reads and searches the published knowledge base at `/kb`.
- **Customers** (`user`) open tickets, see suggested articles while typing the subject, follow their own tickets and
  the public replies, reply, mark a ticket resolved, and read notifications in an in-app inbox.
- **Agents** (`agent`) work the queue (Unassigned, Mine or All, soonest SLA deadline first), claim and assign,
  send public replies or internal notes, change status, priority and category, review the AI triage, ask for a
  suggested reply, and write and publish knowledge-base articles.
- **Admins** see counts only (tickets by status, SLA breaches, AI calls against the daily cap, accounts by role),
  turn customers into agents and back, and load the demo workspace. Ticket content routes answer 404 for admins.

## Try it

1. Open https://app11.breakthruventures.ai and search the **knowledge base** (for example "charged twice"). No account
   needed.
2. Choose **Sign in**, then **New here? Create an account** (password of 10 or more characters). New accounts are
   customers.
3. **Open a ticket.** As you type the subject, matching articles appear. The ticket shows in **Support**, and a
   "We received your ticket" notification lands in **Inbox**.

The agent desk needs an `agent` account, and only an admin can grant that role (**Make agent** on `/admin`). Visitors
can't sign in as the demo users: **Load demo workspace** (admin only) creates 3 customers, 2 agents and 12 tickets in
every state (one with a breached first response, one paused, four with internal notes), and on the live site their
passwords are random and never shown. Locally, the demo seed sets a password you choose (see
[Run it locally](#run-it-locally)).

## Tickets and the SLA engine

**Statuses:** `new` → `open` → `pending_customer` ↔ `open` → `resolved`. A customer reply within 7 days of
`resolved` reopens the ticket; after 7 days the portal offers a follow-up ticket instead.

**SLA targets** (`src/lib/sla.ts`, calendar hours):

| Priority | First response | Resolution |
| --- | --- | --- |
| `urgent` | 1 h | 8 h |
| `high` | 4 h | 24 h |
| `normal` | 8 h | 72 h |
| `low` | 24 h | 120 h |

- Due times are set by the server when the ticket is opened and recomputed from the creation time when the priority
  changes. The first public agent message meets the first-response target.
- The resolution clock **pauses** while the status is `pending_customer` and resumes when the customer replies.
- Each ticket's state (`ok`, `at_risk` with under 25% of the window left, `breached`, `met` or `paused`) is computed
  on every read, and the desk shows chips and countdowns.
- **Breaches are stamped lazily.** Nothing runs between requests on Cloud Run, so every ticket read or write and each
  queue load runs one idempotent update that records any passed deadline (`src/lib/sla-db.ts`). The admin breach
  count adds unstamped ones with the same rule, so it's right even if nobody has looked at a ticket.
- Every change by an agent carries the ticket's `version`; a stale one is a 409 ("This ticket changed since you
  opened it").

**Email is simulated.** `src/lib/mail/` defines a `Mailer` interface. Its only implementation writes a
`mail_message` row in the same transaction as the event, and the recipient reads it at `/inbox`, with an unread
badge in the header. Events: ticket created (to the customer), agent public reply (to the customer), customer reply
(to the assignee), assignment (to the new assignee) and resolved (to the customer). Snippets are built from public
messages only, and `publicSnippet()` refuses an internal note. A real email provider would be another `Mailer`
implementation; none is built.

**Knowledge base** (`src/lib/kb.ts`): Postgres full-text search (`english`, title weighted above body), drafts never
returned publicly. Articles are written in a small Markdown subset that is parsed to plain data and rendered without
raw HTML; only `http` and `https` links are kept. A migration seeds 13 published articles and 2 drafts.

## The AI feature

Two tasks, both single calls to the shared gateway, `generate()` in `src/lib/ai`, with no tools. The code is in
`src/lib/ai/support.ts` (prompts), `src/lib/ai/support-guardrails.ts` (checks) and `src/lib/support-ai.ts` (who may
call, what the model sees, caps).

**Live mode.** `30-apps-infra` asks for Gemini for this app (default model `gemini-flash-lite-latest`), but the
Google Cloud stack deploys with `AI_PROVIDER=demo` until a Gemini key is configured. In demo mode both tasks return
recorded answers, labelled **Demo AI** on the desk. A recorded triage never changes a ticket's category or priority.

**Auto-triage** (`ticket-triage`)

- Runs once per ticket, automatically. Opening a ticket enqueues a `triage-ticket` job in the same transaction, and
  the request waits up to 10 seconds for it. If it doesn't finish, the ticket is saved untriaged and the next agent
  queue load gives pending triage up to 5 seconds more.
- **Input:** the subject (150 characters) and first message (4,000), plus up to 5 candidate published articles found
  by full-text search, labelled `K1` to `K5` (title and first 300 characters).
- **Output** is validated with zod: category (`billing`, `technical`, `account`, `how_to`, `bug`, `feature_request`
  or `other`), priority, a summary of up to 240 characters, sentiment, up to 3 article labels and an optional "needs a
  human because" note. Unknown labels are dropped.
- **It can't jump the queue.** The priority enum is `low`, `normal` or `high`; an answer of `urgent` fails validation
  and leaves the ticket untriaged. Customers have no priority field. Only agents set `urgent`.
- Category and priority are applied and marked **Set by AI** only until an agent sets either. Triage never touches
  status or assignee, and customers never see it. Agents can re-run it 3 times per ticket.

**Suggested reply** (`reply-suggest`)

- An agent chooses **Suggest reply**. The server searches published articles with the subject and the latest
  customer message and passes the top 3 (plus the triage's picks), each body up to 2,000 characters, as `K1` to `K3`.
- **The model sees** the subject and the newest public messages (up to 6, at most 6,000 characters). Internal notes
  are never selected, and the customer's name is not sent.
- **Output** is validated with zod: a reply of up to 1,500 characters, up to 3 citations, a confidence level and an
  optional note for the agent.
- **Checks:** citations outside the provided set are dropped; links in the reply that don't appear in a cited article
  become "[link removed]"; with no articles or no valid citation, confidence is forced to low. A policy scan flags
  refunds, credits, compensation, guarantees, discounts, legal matters, passwords, card details, identity or
  one-time codes, promised timeframes and possible contact details, each shown as a chip to check before sending.
  The scans are aids for the agent, not the control.
- **Never sent automatically.** The draft goes into the agent's reply box ("Not sent. Read it, edit it, then press
  Send."), and the sent message records that it was AI-assisted. Customers never see AI output directly.

**Both prompts** wrap ticket and article text in data blocks with a fresh random marker per request (angle brackets
in the text are removed), and say that this text is data written by customers and staff, never instructions. The
reply prompt forbids promising refunds, credits, discounts, compensation, deadlines or legal outcomes and asking for
passwords, one-time codes or card numbers.

**Recorded answers on a live setup.** If a live provider fails and the gateway falls back to a recorded answer, that
answer is refused: it is never written onto a ticket or shown as a draft.

**Caps:** one automatic triage per ticket; 3 re-triages per ticket and 30 per agent per hour; 20 suggested replies per
agent per hour; `AI_DAILY_CAP` (default 400) model calls per day app-wide, reserved before each call and given back
if the call fails. Logs record task, mode, category, citation count, policy codes and latency, never ticket text.

Evals: `test/ai-evals.test.ts` (stubbed in CI) covers a duplicate charge, an "URGENT, ignore your rules" injection, a
question no article covers, a ticket with an internal note (the prompt must not contain it) and a model that cites
`K7` and adds a stray URL. `pnpm eval:support` runs them against Gemini by hand.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + access rules, zod validation, AI gateway, JSON logs, /api/health
   │                  jobs run inline, inside the request (Cloud Run has no CPU between requests)
   ├──► Postgres (Drizzle): tickets, messages and notes, KB, outbox, job queue
   └──► Model API (Gemini when a key is set, otherwise recorded demo answers)
```

- **Google Cloud Run**, 0 to 1 instances (1 vCPU, 512 MiB), CPU only while handling requests, with Postgres on the
  always-free e2-micro VM over the private network.
- **Nothing runs between requests.** The job worker detects Cloud Run (`K_SERVICE`) and runs in `inline` mode: jobs
  run only inside a request, within a time budget. SLA states are computed on read and breaches stamped lazily, so
  there's no scheduler.
- The agent's ticket page refreshes every 20 seconds; nothing else polls.
- `GET /api/health` reports database status and the deployed image tag, and returns 503 if the database is down.

## Data model

Defined in `src/lib/db/schema.ts`; migrations in `drizzle/`.

| Table | Holds |
| --- | --- |
| `ticket` | Number, subject, status, priority, category, assignee, triage (agents only) and its source (`ai`, `agent`, `none`), due, met, paused and breach times, `version`. Owned by `customer_id` |
| `ticket_message` | Body, author and role, `visibility` (`public` or `internal`), AI-assisted flag. Composite foreign key to the ticket's customer |
| `kb_article` | Slug, title, body, `draft` or `published`, author, generated full-text column |
| `reply_suggestion` | Stored drafts for agents: data, cited article ids, mode, who asked |
| `mail_message` | The in-app outbox: recipient, ticket, kind, subject, snippet, read time |
| `job` | The queue (`triage-ticket` jobs, keyed by ticket) |
| `rate_event`, `daily_usage` | Per-user limits and the app-wide daily AI cap |

## Security

**Roles.** Three roles via Better Auth: `user` (customer), `agent` and `admin`. `agent` has no admin-plugin
permissions; its powers are app-level, in `src/lib/access.ts`. **Admin is not a superset of agent:** `requireRole()`
matches exactly one role. Sign-up can't choose a role; only an admin grants `agent`, logged as `role.changed`.
`src/lib/auth/permissions.ts` withholds impersonation, set-password, set-email and session listing from admins, and
those endpoints are disabled outright.

**Enforcement.**

- Every page calls `requireUserOrRedirect()` or `requireRoleOrRedirect()`; every route handler and server action
  calls `requireUser()` or `requireRole()`.
- **Customers:** every query filters on `customer_id = actor.id`. Another customer's ticket is a 404, never a 403.
  Their message reads filter `visibility = 'public'` in SQL, they can only write public messages, and staff fields
  (assignee, triage, SLA clocks, version) are left out of their responses.
- **Admins** get 404 from every ticket content route.
- Ticket text is rendered as plain text. Mutating routes check the Origin header against `APP_URL`, accept JSON of at
  most 32 KB and validate with zod. Errors go through `errorResponse()`, with no stack traces.
- **Limits:** 5 new tickets per customer per hour and 20 per day, 50 open per customer; 60 messages per user per hour
  (5,000 characters each); 60 KB writes per agent per hour, 500 articles of up to 10,000 characters; the public KB
  routes allow 60 requests per IP per minute; the AI caps above.
- Public sign-ups can't take the reserved demo email domain.

**Tests.** `test/tickets.integration.test.ts` covers every access rule, including id guessing, and scans customer
responses and `mail_message` rows for internal-note text. `test/roles.integration.test.ts` covers role changes and
sign-up attempts that post a role. `test/sla.integration.test.ts` and `src/lib/sla.test.ts` cover every row of the SLA
table, pause and resume, priority changes and idempotent stamping. `test/kb.integration.test.ts`,
`test/ai-support.integration.test.ts`, `test/jobs.integration.test.ts`, `test/admin-permissions.integration.test.ts`
and `test/demo-seed.integration.test.ts` cover search and drafts, the AI paths and caps, inline jobs, admin limits and
the demo seed. `scripts/smoke.sh` runs the customer side over HTTP, and the agent side when agent credentials are
given.

## Known limits

- **AI runs on recorded answers unless a Gemini key is set.** The live deployment uses `AI_PROVIDER=demo` until
  the key is configured in `30-apps-infra`. Demo triage leaves category and priority alone, and demo drafts are
  labelled **Demo AI**. No live evaluation of triage quality is recorded.
- **Visitors can only try the customer side.** The agent desk needs an admin to grant the `agent` role.
- **No real email.** Notifications stay in the in-app inbox; customers reply in the portal.
- SLA targets use calendar hours: no business hours or holidays.
- The per-IP limit on the public KB is held in memory, per instance.
- Out of scope: attachments, guest tickets, macros, satisfaction surveys, multiple brands or teams, live chat and
  merging tickets.

## Free-tier budget

| Resource | Control |
| --- | --- |
| Cloud Run (free monthly requests and CPU) | At most 1 instance, CPU only during requests; triage runs inside the create request (10 s budget); only the agent ticket page polls (every 20 s) |
| e2-micro Postgres (shared) | Text only, no attachments; caps above |
| Gemini | 1 triage per ticket, re-triage and suggestion caps, `AI_DAILY_CAP` per day |
| Email | None sent |

## Configuration

Names only; values live in the cloud's secret store or `.env.local`. See `.env.example` and `src/lib/env.ts`.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (also the only allowed Origin) and display name |
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Session signing, at least 32 characters |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model choice (`demo`, `gemini` or `anthropic`) |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `AI_DAILY_CAP` | Fallback to recorded answers, provider timeout (max 22 s), app-wide daily AI calls |
| `JOBS_WORKER` | `inline`, `timer` or `off`; detected automatically on Cloud Run and Lambda |
| `MIGRATE_ON_START` | Apply migrations at startup (on in the cloud) |
| `LOG_LEVEL` | JSON log level |

## Run it locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db             # Postgres 17
pnpm install
pnpm db:migrate                     # also seeds the knowledge base
pnpm dev                            # http://localhost:3000
```

`AI_PROVIDER=demo` (the default) needs no key or network. To make yourself an admin, sign up, then run
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app is running. To load the demo
workspace with a password you can sign in with, run:

```bash
DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD='<a local password>' \
  pnpm tsx --conditions=react-server scripts/seed-demo.mts
```

Sign in as `avery.agent@demo.breakthru.test` (agent), `casey@demo.breakthru.test` (customer) or
`admin@demo.breakthru.test`. The seed refuses production hosts and databases.

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus integration tests against real Postgres
pnpm build && pnpm smoke                   # HTTP smoke test against a running app (BASE_URL)
```

## Deploy it yourself

Every push to `main` publishes a multi-arch image to `ghcr.io/breakthrudevelopment/11-helpdesk:sha-<commit>`.
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a pinned tag with Terraform. The same
image runs on AWS (Lambda), Azure (Container Apps), Google Cloud (Cloud Run) and Oracle Cloud (Docker on a VM); see
`infra/README.md`. This repo holds no cloud credentials. With `MIGRATE_ON_START=true`, the server applies pending
migrations, including the knowledge-base seed, before taking traffic.

## 2-minute demo script

You need a customer account and an agent account (an admin grants **Make agent**). Steps 2 and 3 show live model
output only when a Gemini key is set; otherwise the triage and draft are recorded answers labelled **Demo AI**.

1. **Customer opens a ticket.** Subject "I was charged twice this month". "Billing: duplicate charges on your
   statement" appears under suggested articles while typing. Open the ticket. *Proves: the knowledge base deflects
   before a ticket is even sent.*
2. **Agent sees the triage.** On **Desk**, the ticket is in **Unassigned** with SLA chips. Its **AI triage** card
   sets the category to Billing, marked **Set by AI**, and cites the duplicate-charges article. *Proves: triage
   from enums and verified articles; it can't set `urgent`.*
3. **Agent asks for a reply.** Choose **Suggest reply**. The draft cites the article, and any mention of a refund
   shows a policy chip. Edit it and choose **Send reply**. *Proves: grounded drafts, and a person always sends.*
4. **Agent adds an internal note.** Switch the message type to **Internal note**, write "Customer is on a legacy discount" and
   choose **Save note**. *Proves: notes are styled apart from public replies.*
5. **Customer checks the inbox.** The agent's reply is in **Inbox** and in the ticket thread; the note appears in
   neither. *Proves: the wall between portals holds, notifications included.*
6. **Wait on the customer.** The agent sets the status to Waiting on customer; the SLA chip shows **Paused**.
   *Proves: honest SLA clocks.*
