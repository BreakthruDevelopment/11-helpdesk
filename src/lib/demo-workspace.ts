import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin } from "@/lib/access";
import { auth } from "@/lib/auth";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { publicSnippet, subjectFor } from "@/lib/mail";
import { firstResponseDueAt, resolutionDueAt } from "@/lib/sla";
import { stampBreaches } from "@/lib/sla-db";
import { releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

/**
 * The demo workspace: 3 customers, 2 agents, 1 admin and 12 tickets across every state, one with a breached first
 * response (T1), one paused (T8), and internal notes on four tickets so access rules have something to hide.
 *
 * Two ways in, both through `loadDemoWorkspace`: the admin button (`POST /api/admin/demo`, rate limited, demo users get
 * random passwords nobody knows, and no admin account is created) and the local CLI (`scripts/seed-demo.mts`, which
 * refuses production hosts first, sets a known DEMO_PASSWORD and also creates the demo admin).
 */

const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One admin load per minute and this many per UTC day, for the whole app. */
export const DEMO_LOADS_PER_DAY = 5;

const PEOPLE = {
  casey: { name: "Casey Rivera", local: "casey", role: "user" },
  devon: { name: "Devon Park", local: "devon", role: "user" },
  emery: { name: "Emery Lane", local: "emery", role: "user" },
  avery: { name: "Avery Stone", local: "avery.agent", role: "agent" },
  blake: { name: "Blake Moreno", local: "blake.agent", role: "agent" },
  admin: { name: "Demo Admin", local: "admin", role: "admin" },
} as const;
type Person = keyof typeof PEOPLE;
export const demoEmail = (p: Person) => `${PEOPLE[p].local}@${DEMO_EMAIL_DOMAIN}`;

type Msg = { at: number; by: "customer" | "avery" | "blake"; vis?: "internal"; body: string };
type Spec = {
  customer: "casey" | "devon" | "emery";
  subject: string;
  /** Hours before the load that the ticket was created. */
  age: number;
  status: (typeof schema.TICKET_STATUSES)[number];
  priority: (typeof schema.TICKET_PRIORITIES)[number];
  category: (typeof schema.TICKET_CATEGORIES)[number];
  assignee?: "avery" | "blake";
  /** `at` on messages is hours after creation; so are these. */
  pausedAt?: number;
  resolvedAt?: number;
  ai?: boolean;
  messages: Msg[];
};

const aiTriage = (category: Spec["category"], summary: string) => ({
  category,
  priority: "normal",
  summary: `Demo triage (recorded): ${summary}`,
  sentiment: "calm",
  articleRefs: [],
  needsHumanBecause: null,
});

export const DEMO_TICKETS: Spec[] = [
  { customer: "casey", subject: "Site is down for all of our users", age: 5, status: "new", priority: "urgent", category: "technical", messages: [{ at: 0, by: "customer", body: "Since this morning every page returns an error for our whole team. We can't work. Please help." }] },
  { customer: "devon", subject: "How do I export my data?", age: 1, status: "new", priority: "normal", category: "how_to", ai: true, messages: [{ at: 0, by: "customer", body: "Is there a way to export everything to CSV? I can't find the option." }] },
  { customer: "emery", subject: "Feature idea: dark mode", age: 2, status: "new", priority: "low", category: "feature_request", messages: [{ at: 0, by: "customer", body: "Would love a dark theme for night shifts. Any plans?" }] },
  {
    customer: "casey", subject: "Charged twice this month", age: 20, status: "open", priority: "high", category: "billing", assignee: "avery",
    messages: [
      { at: 0, by: "customer", body: "My card shows two charges for this month's plan. Can you check?" },
      { at: 2, by: "avery", body: "Thanks for flagging this. I can see both charges and I'm looking into why." },
      { at: 3, by: "avery", vis: "internal", body: "Customer is on a legacy discount plan. Check with finance before offering anything." },
    ],
  },
  {
    customer: "devon", subject: "Cannot reset my password", age: 10, status: "open", priority: "normal", category: "account", assignee: "blake", ai: true,
    messages: [
      { at: 0, by: "customer", body: "The reset email never arrives. I tried three times." },
      { at: 1, by: "blake", body: "Sorry about that. Could you tell me which address you signed up with?" },
      { at: 4, by: "customer", body: "It's the one I'm writing from." },
      { at: 5, by: "blake", vis: "internal", body: "Checked the logs: reset mails are bouncing for this domain. Escalate to ops." },
    ],
  },
  {
    customer: "emery", subject: "Invoice PDF is missing our logo", age: 6, status: "open", priority: "normal", category: "bug", assignee: "avery",
    messages: [
      { at: 0, by: "customer", body: "The PDF invoices used to have our logo in the header. Now it's blank." },
      { at: 1, by: "avery", vis: "internal", body: "Reproduced on staging. Looks like the logo URL changed. Fix in progress." },
    ],
  },
  {
    customer: "casey", subject: "Where are the API docs?", age: 40, status: "open", priority: "low", category: "how_to",
    messages: [
      { at: 0, by: "customer", body: "I can't find the API documentation anywhere." },
      { at: 20, by: "blake", body: "They're linked from the Help menu under Developers." },
    ],
  },
  {
    customer: "devon", subject: "Webhook returns a 500", age: 30, status: "pending_customer", priority: "normal", category: "technical", assignee: "blake", pausedAt: 3,
    messages: [
      { at: 0, by: "customer", body: "Our webhook endpoint gets a 500 from you on every delivery." },
      { at: 1, by: "blake", body: "Could you send the exact time of one failed delivery and the event type?" },
    ],
  },
  {
    customer: "emery", subject: "Update our billing address", age: 100, status: "resolved", priority: "normal", category: "billing", assignee: "avery", resolvedAt: 5,
    messages: [
      { at: 0, by: "customer", body: "We moved offices. How do I change the billing address?" },
      { at: 2, by: "avery", body: "You can change it under Settings, Billing. I've also updated it on our side." },
    ],
  },
  {
    customer: "casey", subject: "Question about plan limits", age: 288, status: "resolved", priority: "low", category: "other", assignee: "blake", resolvedAt: 48,
    messages: [
      { at: 0, by: "customer", body: "What happens when we go over the seat limit?" },
      { at: 24, by: "blake", body: "Extra seats are billed pro rata at the end of the month." },
    ],
  },
  {
    customer: "devon", subject: "Login loop on mobile", age: 60, status: "resolved", priority: "high", category: "bug", assignee: "avery", resolvedAt: 20,
    messages: [
      { at: 0, by: "customer", body: "On my phone I sign in and get bounced back to the sign-in page." },
      { at: 1, by: "avery", body: "Thanks, we've reproduced it and a fix is rolling out." },
      { at: 2, by: "avery", vis: "internal", body: "Cookie SameSite regression from last release. Hotfix deployed." },
    ],
  },
  { customer: "emery", subject: "Payments failing at checkout", age: 0.5, status: "open", priority: "urgent", category: "technical", assignee: "avery", messages: [{ at: 0, by: "customer", body: "Customers report their card payments fail at checkout since a few minutes ago." }] },
];

/** One constant key serializes every demo load and reservation across processes. */
const LOCK_KEY = "demo-load";
const tryLock = (tx: Pick<ReturnType<typeof db>, "execute">) =>
  tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as ok`);

/**
 * Atomic global reservation: one load per minute and `DEMO_LOADS_PER_DAY` per UTC day for the whole app. Runs in its
 * own short transaction under the load lock, so two requests can't both reserve; a refusal leaves no trace.
 * (Nothing else may use the pool while a transaction holds its connection, so no transaction in this file ever
 * spans the load: it works with a one-connection pool, `DB_POOL_MAX=1`.)
 */
async function reserve(actor: Actor): Promise<void> {
  await db().transaction(async (tx) => {
    const [{ ok }] = await tryLock(tx);
    if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
    const { rateEvent } = schema;
    const any = eq(rateEvent.kind, "demo_load");
    await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
    const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
    if (n) throw new TooManyRequestsError("Demo workspace can be loaded once per minute. Try again shortly.");
    if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
      throw new TooManyRequestsError("The demo workspace was loaded the maximum number of times today. Try again tomorrow.");
    }
    await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
  });
}

/** A load that failed after reserving gives its reservation back. */
async function release(actor: Actor): Promise<void> {
  await db().transaction(async (tx) => {
    await releaseRate(tx, actor.id, "demo_load");
    await releaseDaily(tx, "demo_load");
  });
}

export type DemoLoadResult = { users: number; tickets: number; messages: number; notifications: number };

/**
 * Default is the safe admin-route mode. CLI mode independently rechecks all guards.
 * `now` is only for tests; no HTTP input reaches it.
 */
export async function loadDemoWorkspace(
  actor: Actor,
  options: unknown = { mode: "admin" },
  now: Date = new Date(),
  { reserve: reserveSlot = false }: { reserve?: boolean } = {},
): Promise<DemoLoadResult> {
  assertAdmin(actor);
  const parsed = optionsSchema.parse(options);
  if (reserveSlot) {
    await reserve(actor);
    log.info("admin.demo_load", { by: actor.id });
  }
  try {
    const result = await loadDemo(actor, parsed.mode, now);
    log.info("demo.loaded", { by: actor.id, mode: parsed.mode, ...result });
    return result;
  } catch (err) {
    if (reserveSlot) await release(actor).catch(() => undefined);
    throw err;
  }
}

/** Postgres unique violation, possibly wrapped by Drizzle (`cause`). */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));

async function loadDemo(actor: Actor, mode: "admin" | "cli", now: Date): Promise<DemoLoadResult> {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  const ctx = await auth().$context;
  // The admin button creates no admin account: a demo admin with a password nobody knows is still an admin account.
  const who = (Object.keys(PEOPLE) as Person[]).filter((p) => mode === "cli" || PEOPLE[p].role !== "admin");
  const people = new Map<Person, string>();

  // Preflight every identity before changing anything. An unrelated account at a demo address is never adopted.
  for (const p of who) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, demoEmail(p)));
    if (existing && existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  for (const p of who) {
    const { role, name } = PEOPLE[p];
    const email = demoEmail(p);
    // Rotate every time, so a previous CLI password can't sign in on a live load.
    const secret = password ?? randomBytes(32).toString("base64url");
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, email));
    if (existing) {
      // The adapter and hasher are Better Auth's own, so the password format and hooks are preserved.
      await ctx.internalAdapter.updateUser(existing.id, { role });
      await ctx.internalAdapter.updatePassword(existing.id, await ctx.password.hash(secret));
      await ctx.internalAdapter.deleteUserSessions(existing.id);
      people.set(p, existing.id);
    } else {
      // Written with Drizzle, not Better Auth: the auth hooks refuse demo emails and marker images.
      const newId = randomUUID();
      try {
        await db().transaction(async (tx) => {
          await tx.insert(schema.user).values({ id: newId, email, name, role, image: MARKER });
          await tx.insert(schema.account).values({ id: randomUUID(), accountId: newId, providerId: "credential", userId: newId, password: await hashPassword(secret) });
        });
      } catch (e) {
        // A real account took the demo email since the preflight: report a conflict, not a crash.
        if (isUniqueViolation(e)) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
        throw e;
      }
      people.set(p, newId);
    }
  }
  const ids = [...people.values()];
  const id = (p: Person) => people.get(p)!;

  const { ticket, ticketMessage, mailMessage, rateEvent } = schema;
  const HOUR = 3_600_000;
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
  let messages = 0;
  let notifications = 0;

  await db().transaction(async (tx) => {
    // Serialize loads (the CLI and the route can overlap): wait for the lock, never nest another pool use inside.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`);
    // Replace only the demo users' data. Ids come from the marker-checked accounts above, never from a name or a
    // SQL predicate. Deleting a customer's tickets cascades to their messages and every notification about them.
    await tx.delete(ticket).where(inArray(ticket.customerId, ids));
    await tx.delete(mailMessage).where(inArray(mailMessage.recipientId, ids));
    await tx.delete(rateEvent).where(and(inArray(rateEvent.userId, ids), sql`${rateEvent.kind} <> 'demo_load'`));

    for (const spec of DEMO_TICKETS) {
      const created = at(spec.age);
      const offset = (h: number) => new Date(created.getTime() + h * HOUR);
      const firstAgentReply = spec.messages.find((m) => m.by !== "customer" && !m.vis);
      const pausedSeconds = 0;
      const [row] = await tx
        .insert(ticket)
        .values({
          customerId: id(spec.customer),
          subject: spec.subject,
          status: spec.status,
          priority: spec.priority,
          category: spec.category,
          assigneeId: spec.assignee ? id(spec.assignee) : null,
          triage: spec.ai ? aiTriage(spec.category, spec.subject) : null,
          triageSource: spec.ai ? "ai" : "none",
          firstResponseDueAt: firstResponseDueAt(spec.priority, created),
          resolutionDueAt: resolutionDueAt(spec.priority, created, pausedSeconds),
          firstRespondedAt: firstAgentReply ? offset(firstAgentReply.at) : null,
          resolvedAt: spec.resolvedAt !== undefined ? offset(spec.resolvedAt) : null,
          pausedAt: spec.pausedAt !== undefined ? offset(spec.pausedAt) : null,
          pausedSeconds,
          createdAt: created,
          updatedAt: offset(Math.max(0, ...spec.messages.map((m) => m.at), spec.resolvedAt ?? 0, spec.pausedAt ?? 0)),
          // What the customer sees: public messages and status changes only, never the internal notes.
          publicActivityAt: offset(Math.max(0, ...spec.messages.filter((m) => !m.vis).map((m) => m.at), spec.resolvedAt ?? 0, spec.pausedAt ?? 0)),
        })
        .returning();

      const mail: (typeof mailMessage.$inferInsert)[] = [];
      for (const m of spec.messages) {
        const authorId = m.by === "customer" ? id(spec.customer) : id(m.by);
        const [inserted] = await tx
          .insert(ticketMessage)
          .values({ ticketId: row.id, customerId: row.customerId, authorId, authorRole: m.by === "customer" ? "customer" : "agent", visibility: m.vis ?? "public", body: m.body, createdAt: offset(m.at) })
          .returning();
        messages += 1;
        // The same rules as the live outbox: public messages only, through publicSnippet().
        if (inserted.visibility !== "public") continue;
        if (m.at === 0 && m.by === "customer") {
          mail.push({ recipientId: row.customerId, kind: "ticket_created", ticketId: row.id, subject: subjectFor(`We received your ticket #${row.number}: ${row.subject}`), snippet: publicSnippet(inserted), createdAt: offset(m.at) });
        } else if (m.by !== "customer") {
          mail.push({ recipientId: row.customerId, kind: "agent_reply", ticketId: row.id, subject: subjectFor(`Re: ${row.subject}`), snippet: publicSnippet(inserted), createdAt: offset(m.at) });
        } else if (row.assigneeId) {
          mail.push({ recipientId: row.assigneeId, kind: "customer_reply", ticketId: row.id, subject: subjectFor(`Re: ${row.subject}`), snippet: publicSnippet(inserted), createdAt: offset(m.at) });
        }
      }
      if (row.assigneeId) {
        mail.push({ recipientId: row.assigneeId, kind: "ticket_assigned", ticketId: row.id, subject: subjectFor(`Assigned to you: ${row.subject}`), snippet: `Ticket #${row.number} was assigned to you.`, createdAt: offset(0.1) });
      }
      if (row.status === "resolved") {
        mail.push({ recipientId: row.customerId, kind: "ticket_resolved", ticketId: row.id, subject: subjectFor(`Resolved: ${row.subject}`), snippet: "Your ticket was marked resolved. Reply within 7 days if the problem comes back.", createdAt: row.resolvedAt! });
      }
      // The newest notification per recipient stays unread, so the header badge has something to show.
      const newest = new Map<string, Date>();
      for (const m of mail) if (!newest.has(m.recipientId) || m.createdAt! > newest.get(m.recipientId)!) newest.set(m.recipientId, m.createdAt!);
      await tx.insert(mailMessage).values(mail.map((m) => ({ ...m, readAt: newest.get(m.recipientId)!.getTime() === m.createdAt!.getTime() ? null : m.createdAt })));
      notifications += mail.length;
    }
    // Record the breach(es) the data implies, exactly as the live app would on the first read.
    await stampBreaches(tx);
  });

  return { users: people.size, tickets: DEMO_TICKETS.length, messages, notifications };
}
