import "server-only";
import { type SQL, and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type ContentAccess, contentAccess, messageScope, ticketScope } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { mailer } from "@/lib/mail/outbox";
import { publicSnippet, subjectFor } from "@/lib/mail";
import { firstResponseDueAt, pausedFor, resolutionDueAt } from "@/lib/sla";
import { stampBreaches } from "@/lib/sla-db";
import { type Tx, consumeRate } from "@/lib/usage";

/**
 * Ticket and message data functions. Each one takes the acting user and starts with `contentAccess(actor)`
 * (src/lib/access.ts): customers are limited to their own tickets and to public messages in the SQL itself, agents
 * see everything, admins get a 404. Customers and agents get different, explicit response shapes: the customer
 * shape is an allow-list of columns, so a column added later is invisible to customers until someone adds it here.
 */

const { ticket, ticketMessage, user } = schema;
const author = alias(user, "author");

// ---------------------------------------------------------------------------
// Limits (spec: "Rate limits and caps")
// ---------------------------------------------------------------------------

export const LIMITS = {
  ticketsPerHour: 5,
  ticketsPerDay: 20,
  openPerCustomer: 50,
  messagesPerHour: 60,
  bodyMax: 5000,
  subjectMax: 150,
  /** A customer reply this long after `resolved` no longer reopens the ticket; they open a follow-up instead. */
  reopenDays: 7,
} as const;

/** A thread response carries the newest this many visible messages (oldest first). */
export const THREAD_WINDOW = 500;

const DAY_SECONDS = 86_400;
const REOPEN_MS = LIMITS.reopenDays * DAY_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const newTicketInput = z
  .object({
    subject: z.string().trim().min(1, "Subject is required").max(LIMITS.subjectMax),
    body: z.string().trim().min(1, "Describe the problem").max(LIMITS.bodyMax),
  })
  .strict();

export const messageInput = z
  .object({
    body: z.string().trim().min(1, "Write a message").max(LIMITS.bodyMax),
    visibility: z.enum(schema.MESSAGE_VISIBILITIES).default("public"),
    aiAssisted: z.boolean().default(false),
  })
  .strict();

/** What an agent may set. `new` is never a target: a ticket leaves it once and can't return. */
export const agentPatchInput = z
  .object({
    version: z.number().int().min(1),
    status: z.enum(["open", "pending_customer", "resolved"]).optional(),
    priority: z.enum(schema.TICKET_PRIORITIES).optional(),
    category: z.enum(schema.TICKET_CATEGORIES).optional(),
    assigneeId: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.priority !== undefined || v.category !== undefined || v.assigneeId !== undefined, {
    message: "Nothing to change",
  });

export const customerPatchInput = z.object({ action: z.literal("resolve") }).strict();

export const listQuery = z.object({
  view: z.enum(["unassigned", "mine", "all"]).default("all"),
  status: z.enum(schema.TICKET_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Rows to skip, for paging past `limit`: the response's `nextOffset` when `hasMore` is true. */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type Page = { hasMore: boolean; nextOffset: number | null };

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** All a customer ever sees of a ticket: no assignee, triage, SLA clocks, priority, category or version. */
export type CustomerTicket = {
  id: string;
  number: number;
  subject: string;
  status: (typeof schema.TICKET_STATUSES)[number];
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  /** True once resolved for more than 7 days: replying is refused and the portal offers "Open a follow-up". */
  followUp: boolean;
};

export type CustomerMessage = {
  id: string;
  authorRole: (typeof schema.MESSAGE_AUTHOR_ROLES)[number];
  mine: boolean;
  body: string;
  createdAt: Date;
};

export type AgentTicket = typeof ticket.$inferSelect & { customerName: string | null };

export type AgentMessage = typeof ticketMessage.$inferSelect & { authorName: string | null };

const customerTicketColumns = {
  id: ticket.id,
  number: ticket.number,
  subject: ticket.subject,
  status: ticket.status,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
  resolvedAt: ticket.resolvedAt,
};

type CustomerTicketRow = {
  id: string;
  number: number;
  subject: string;
  status: CustomerTicket["status"];
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

function toCustomerTicket(row: CustomerTicketRow, now: Date): CustomerTicket {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    followUp: row.status === "resolved" && row.resolvedAt !== null && now.getTime() - row.resolvedAt.getTime() > REOPEN_MS,
  };
}

function toCustomerMessage(row: { id: string; authorId: string | null; authorRole: CustomerMessage["authorRole"]; body: string; createdAt: Date }, actor: Actor): CustomerMessage {
  return { id: row.id, authorRole: row.authorRole, mine: row.authorId === actor.id, body: row.body, createdAt: row.createdAt };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The transaction's clock, the same one `now()` uses in stampBreaches, so the two never disagree. */
async function dbNow(tx: Pick<Tx, "execute">): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(row.now);
}

/** A malformed id is a missing ticket, not a validation error: probing ids must look the same as a miss. */
function ticketId(id: string): string {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

/** The ticket row, locked for this transaction, restricted to what the actor may touch. 404 when there is none. */
async function lockTicket(tx: Tx, access: ContentAccess, id: string) {
  const [row] = await tx
    .select()
    .from(ticket)
    .where(and(eq(ticket.id, id), ticketScope(access)))
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

type Changes = Partial<typeof ticket.$inferInsert>;

/** Leaving `pending_customer`: the waiting time moves the resolution deadline later and the clock runs again. */
function resumeClock(row: typeof ticket.$inferSelect, now: Date): { changes: Changes; pausedSeconds: number } {
  if (!row.pausedAt) return { changes: {}, pausedSeconds: row.pausedSeconds };
  const elapsed = pausedFor(row.pausedAt, now);
  return {
    pausedSeconds: row.pausedSeconds + elapsed,
    changes: {
      pausedAt: null,
      pausedSeconds: row.pausedSeconds + elapsed,
      resolutionDueAt: new Date(row.resolutionDueAt.getTime() + elapsed * 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * A customer opens a ticket with its first (public) message. The ticket, the message, the rate-limit rows and the
 * "ticket created" notification commit together or not at all. Triage (issue 11.3) will enqueue its job here,
 * inside this transaction.
 */
export async function createTicket(actor: Actor, input: unknown): Promise<{ ticket: CustomerTicket; messages: CustomerMessage[] }> {
  const access = contentAccess(actor);
  if (access.kind !== "customer") throw new ForbiddenError("Only customers open tickets.");
  const data = newTicketInput.parse(input);

  const result = await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "ticket", LIMITS.ticketsPerHour, "You can open 5 tickets per hour. Try again later.");
    await consumeRate(tx, actor.id, "ticket_day", LIMITS.ticketsPerDay, "You can open 20 tickets per day. Try again tomorrow.", { windowSeconds: DAY_SECONDS });
    // The rate lock above serializes this customer's creates, so the count can't be raced past the cap.
    const [{ open }] = await tx
      .select({ open: count() })
      .from(ticket)
      .where(and(eq(ticket.customerId, actor.id), ne(ticket.status, "resolved")));
    if (open >= LIMITS.openPerCustomer) throw new ConflictError("You have 50 open tickets. Wait for some to be resolved before opening more.");

    const now = await dbNow(tx);
    const [row] = await tx
      .insert(ticket)
      .values({
        customerId: actor.id,
        subject: data.subject,
        createdAt: now,
        updatedAt: now,
        // Due times are the server's: there is no priority field for a customer to set.
        firstResponseDueAt: firstResponseDueAt("normal", now),
        resolutionDueAt: resolutionDueAt("normal", now, 0),
      })
      .returning(customerTicketColumns);
    const [message] = await tx
      .insert(ticketMessage)
      .values({ ticketId: row.id, customerId: actor.id, authorId: actor.id, authorRole: "customer", visibility: "public", body: data.body, createdAt: now })
      .returning();
    await mailer().send(tx, {
      recipientId: actor.id,
      kind: "ticket_created",
      ticketId: row.id,
      subject: subjectFor(`We received your ticket #${row.number}: ${row.subject}`),
      snippet: publicSnippet(message),
    });
    return { row, message, now };
  });

  log.info("ticket.created", { ticketId: result.row.id, by: actor.id });
  return { ticket: toCustomerTicket(result.row, result.now), messages: [toCustomerMessage(result.message, actor)] };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Customers: their own tickets, newest activity first. Agents: the queue (see `view`), soonest resolution due first.
 * Both page with `limit` and `offset`: `hasMore` says whether another page exists and `nextOffset` where it starts.
 */
export async function listTickets(actor: Actor, query: unknown = {}): Promise<({ tickets: CustomerTicket[] } | { tickets: AgentTicket[] }) & Page> {
  const access = contentAccess(actor);
  const q = listQuery.parse(query);
  await stampBreaches(db());
  const now = new Date();
  const page = <T,>(rows: T[]): { rows: T[] } & Page => {
    const hasMore = rows.length > q.limit;
    return { rows: rows.slice(0, q.limit), hasMore, nextOffset: hasMore ? q.offset + q.limit : null };
  };

  if (access.kind === "customer") {
    const rows = await db()
      .select(customerTicketColumns)
      .from(ticket)
      .where(and(ticketScope(access), q.status ? eq(ticket.status, q.status) : undefined))
      .orderBy(desc(ticket.updatedAt), desc(ticket.id))
      .limit(q.limit + 1)
      .offset(q.offset);
    const p = page(rows);
    return { tickets: p.rows.map((r) => toCustomerTicket(r, now)), hasMore: p.hasMore, nextOffset: p.nextOffset };
  }

  const view: SQL | undefined =
    q.view === "mine"
      ? eq(ticket.assigneeId, access.agentId)
      : q.view === "unassigned"
        ? and(sql`${ticket.assigneeId} is null`, ne(ticket.status, "resolved"))
        : undefined;
  const rows = await db()
    .select({ ticket, customerName: user.name })
    .from(ticket)
    .leftJoin(user, eq(user.id, ticket.customerId))
    .where(and(ticketScope(access), view, q.status ? eq(ticket.status, q.status) : undefined))
    // Open work first, the soonest resolution deadline at the top; the id keeps pages stable. Issue 11.2 refines the queue.
    .orderBy(asc(sql`(${ticket.status} = 'resolved')`), asc(ticket.resolutionDueAt), asc(ticket.id))
    .limit(q.limit + 1)
    .offset(q.offset);
  const p = page(rows);
  return { tickets: p.rows.map((r) => ({ ...r.ticket, customerName: r.customerName })), hasMore: p.hasMore, nextOffset: p.nextOffset };
}

export async function getTicket(
  actor: Actor,
  id: string,
): Promise<{ ticket: CustomerTicket; messages: CustomerMessage[] } | { ticket: AgentTicket; messages: AgentMessage[] }> {
  const access = contentAccess(actor);
  const tid = ticketId(id);
  await stampBreaches(db());

  if (access.kind === "customer") {
    const [row] = await db().select(customerTicketColumns).from(ticket).where(and(eq(ticket.id, tid), ticketScope(access)));
    if (!row) throw new NotFoundError();
    // `messageScope` puts `visibility = 'public'` in the WHERE: an internal note is never read, then filtered out.
    const messages = await db()
      .select({ id: ticketMessage.id, authorId: ticketMessage.authorId, authorRole: ticketMessage.authorRole, body: ticketMessage.body, createdAt: ticketMessage.createdAt })
      .from(ticketMessage)
      .where(and(eq(ticketMessage.ticketId, tid), messageScope(access)))
      .orderBy(desc(ticketMessage.createdAt), desc(ticketMessage.id))
      .limit(THREAD_WINDOW);
    // The newest messages, oldest first: a long thread keeps showing new replies instead of freezing on the first 500.
    return { ticket: toCustomerTicket(row, new Date()), messages: messages.reverse().map((m) => toCustomerMessage(m, actor)) };
  }

  const [found] = await db()
    .select({ ticket, customerName: user.name })
    .from(ticket)
    .leftJoin(user, eq(user.id, ticket.customerId))
    .where(and(eq(ticket.id, tid), ticketScope(access)));
  if (!found) throw new NotFoundError();
  const messages = await db()
    .select({ message: ticketMessage, authorName: author.name })
    .from(ticketMessage)
    .leftJoin(author, eq(author.id, ticketMessage.authorId))
    .where(and(eq(ticketMessage.ticketId, tid), messageScope(access)))
    .orderBy(desc(ticketMessage.createdAt), desc(ticketMessage.id))
    .limit(THREAD_WINDOW);
  return { ticket: { ...found.ticket, customerName: found.customerName }, messages: messages.reverse().map((m) => ({ ...m.message, authorName: m.authorName })) };
}

// ---------------------------------------------------------------------------
// Messages and notes
// ---------------------------------------------------------------------------

/**
 * Add a message. Customers write public messages only (an `internal` request is a 403 and nothing is stored); agents
 * write public replies or internal notes. Only public messages can reach a notification, and only through
 * `publicSnippet()`. A customer reply resumes a paused clock and reopens a ticket resolved within 7 days; an agent's
 * first public reply stamps the first response and moves `new` to `open`.
 */
export async function addMessage(actor: Actor, id: string, input: unknown): Promise<CustomerMessage | AgentMessage> {
  const access = contentAccess(actor);
  const tid = ticketId(id);
  const data = messageInput.parse(input);
  if (access.kind === "customer" && (data.visibility !== "public" || data.aiAssisted)) {
    throw new ForbiddenError("Customers can only send public messages.");
  }

  const message = await db().transaction(async (tx) => {
    await stampBreaches(tx); // before first_responded_at changes, so a late reply still leaves its breach on record
    const row = await lockTicket(tx, access, tid);
    const now = await dbNow(tx);
    await consumeRate(tx, actor.id, "message", LIMITS.messagesPerHour, "You can send 60 messages per hour. Try again later.");

    const changes: Changes = {};
    let status = row.status;
    if (access.kind === "customer") {
      if (row.status === "resolved") {
        if (!row.resolvedAt || now.getTime() - row.resolvedAt.getTime() > REOPEN_MS) {
          throw new ConflictError("This ticket was resolved more than 7 days ago. Open a follow-up ticket instead.");
        }
        status = "open";
        changes.resolvedAt = null;
      } else if (row.status === "pending_customer") {
        status = "open";
      }
      if (row.pausedAt) Object.assign(changes, resumeClock(row, now).changes);
    } else if (data.visibility === "public") {
      if (row.status === "new") status = "open";
      if (!row.firstRespondedAt) changes.firstRespondedAt = now;
    }
    if (status !== row.status) changes.status = status;

    const [inserted] = await tx
      .insert(ticketMessage)
      .values({
        ticketId: row.id,
        customerId: row.customerId,
        authorId: actor.id,
        authorRole: access.kind === "customer" ? "customer" : "agent",
        visibility: data.visibility,
        body: data.body,
        aiAssisted: data.aiAssisted,
        createdAt: now,
      })
      .returning();

    // `version` moves only when the row's agent-visible state does (status, clock, first response), not for a note.
    const substantive = Object.keys(changes).length > 0;
    await tx
      .update(ticket)
      .set({ ...changes, updatedAt: now, ...(substantive ? { version: sql`${ticket.version} + 1` } : {}) })
      .where(eq(ticket.id, row.id));

    // Notifications. Internal notes notify nobody, and publicSnippet() refuses a note outright.
    if (inserted.visibility === "public") {
      if (access.kind === "agent") {
        await mailer().send(tx, {
          recipientId: row.customerId,
          kind: "agent_reply",
          ticketId: row.id,
          subject: subjectFor(`Re: ${row.subject}`),
          snippet: publicSnippet(inserted),
        });
      } else if (row.assigneeId) {
        await mailer().send(tx, {
          recipientId: row.assigneeId,
          kind: "customer_reply",
          ticketId: row.id,
          subject: subjectFor(`Re: ${row.subject}`),
          snippet: publicSnippet(inserted),
        });
      }
    }
    return inserted;
  });

  log.info("ticket.message_added", { ticketId: tid, by: actor.id, visibility: message.visibility });
  return access.kind === "customer" ? toCustomerMessage(message, actor) : { ...message, authorName: null };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const AGENT_TRANSITIONS: Record<(typeof schema.TICKET_STATUSES)[number], readonly string[]> = {
  new: ["open", "pending_customer", "resolved"],
  open: ["pending_customer", "resolved"],
  pending_customer: ["open", "resolved"],
  resolved: ["open"],
};

/**
 * Customers: `{ action: "resolve" }` only, anything else is a 403. Agents: status, priority, category and assignee,
 * with the `version` they read; a stale version is a 409 and nothing changes. A priority change recomputes both due
 * times from `created_at`; entering `pending_customer` pauses the resolution clock, leaving it resumes it.
 */
export async function updateTicket(actor: Actor, id: string, input: unknown): Promise<CustomerTicket | AgentTicket> {
  const access = contentAccess(actor);
  const tid = ticketId(id);
  return access.kind === "customer" ? resolveAsCustomer(actor, access, tid, input) : updateAsAgent(actor, access, tid, input);
}

async function resolveAsCustomer(actor: Actor, access: ContentAccess, tid: string, input: unknown): Promise<CustomerTicket> {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  // Agent fields from a customer are an attempt, not a typo.
  if (Object.keys(raw).some((k) => k !== "action")) throw new ForbiddenError("Customers can only mark their own ticket resolved.");
  customerPatchInput.parse(raw);

  return db().transaction(async (tx) => {
    await stampBreaches(tx);
    const row = await lockTicket(tx, access, tid);
    const now = await dbNow(tx);
    if (row.status === "resolved") return toCustomerTicket(row, now);
    const [updated] = await tx
      .update(ticket)
      .set({ ...resumeClock(row, now).changes, status: "resolved", resolvedAt: now, updatedAt: now, version: sql`${ticket.version} + 1` })
      .where(eq(ticket.id, row.id))
      .returning(customerTicketColumns);
    log.info("ticket.resolved", { ticketId: tid, by: actor.id, who: "customer" });
    return toCustomerTicket(updated, now);
  });
}

async function updateAsAgent(actor: Actor, access: ContentAccess, tid: string, input: unknown): Promise<AgentTicket> {
  const v = agentPatchInput.parse(input);

  const updated = await db().transaction(async (tx) => {
    await stampBreaches(tx);
    const row = await lockTicket(tx, access, tid);
    if (row.version !== v.version) throw new ConflictError("This ticket changed since you opened it. Reload and try again.");
    const now = await dbNow(tx);

    const changes: Changes = {};
    let status = row.status;
    let assigneeChanged = false;

    if (v.assigneeId !== undefined && v.assigneeId !== row.assigneeId) {
      if (v.assigneeId !== null) {
        const [agent] = await tx
          .select({ id: user.id })
          .from(user)
          .where(and(eq(user.id, v.assigneeId), eq(user.role, "agent"), sql`coalesce(${user.banned}, false) = false`));
        if (!agent) throw new BadRequestError("Tickets can only be assigned to support agents.");
        // Claiming a new ticket starts work on it.
        if (row.status === "new" && v.status === undefined) status = "open";
      }
      changes.assigneeId = v.assigneeId;
      assigneeChanged = v.assigneeId !== null;
    }

    if (v.status !== undefined) status = v.status;
    let pausedSeconds = row.pausedSeconds;
    if (status !== row.status) {
      if (!AGENT_TRANSITIONS[row.status].includes(status)) throw new ConflictError(`A ${row.status.replace("_", " ")} ticket can't move to ${status.replace("_", " ")}.`);
      changes.status = status;
      if (row.status === "pending_customer") {
        const resumed = resumeClock(row, now);
        Object.assign(changes, resumed.changes);
        pausedSeconds = resumed.pausedSeconds;
      }
      if (status === "pending_customer") changes.pausedAt = now;
      if (status === "resolved") changes.resolvedAt = now;
      if (row.status === "resolved") changes.resolvedAt = null;
    }

    if (v.priority !== undefined && v.priority !== row.priority) {
      changes.priority = v.priority;
      changes.triageSource = "agent";
      changes.firstResponseDueAt = firstResponseDueAt(v.priority, row.createdAt);
      changes.resolutionDueAt = resolutionDueAt(v.priority, row.createdAt, pausedSeconds);
    }
    if (v.category !== undefined && v.category !== row.category) {
      changes.category = v.category;
      changes.triageSource = "agent";
    }

    if (Object.keys(changes).length === 0) return { ...row, customerName: null as string | null };

    // Resolving ends both clocks for good, and stampBreaches() skips resolved tickets, so a breach that only exists
    // under the deadlines this same change sets (a priority raise plus a resolve) must be recorded now.
    if (changes.status === "resolved") {
      const resolutionDue = changes.resolutionDueAt ?? row.resolutionDueAt;
      if (!row.breachedResolutionAt && resolutionDue < now) changes.breachedResolutionAt = resolutionDue;
      const firstDue = changes.firstResponseDueAt ?? row.firstResponseDueAt;
      if (!row.breachedFirstResponseAt && !row.firstRespondedAt && firstDue < now) changes.breachedFirstResponseAt = firstDue;
    }

    const [saved] = await tx
      .update(ticket)
      .set({ ...changes, updatedAt: now, version: row.version + 1 })
      .where(and(eq(ticket.id, row.id), eq(ticket.version, row.version)))
      .returning();
    if (!saved) throw new ConflictError("This ticket changed since you opened it. Reload and try again.");

    if (assigneeChanged && changes.assigneeId && changes.assigneeId !== actor.id) {
      await mailer().send(tx, {
        recipientId: changes.assigneeId,
        kind: "ticket_assigned",
        ticketId: row.id,
        subject: subjectFor(`Assigned to you: ${row.subject}`),
        snippet: `Ticket #${row.number} was assigned to you.`,
      });
    }
    if (changes.status === "resolved") {
      await mailer().send(tx, {
        recipientId: row.customerId,
        kind: "ticket_resolved",
        ticketId: row.id,
        subject: subjectFor(`Resolved: ${row.subject}`),
        snippet: "Your ticket was marked resolved. Reply within 7 days if the problem comes back.",
      });
    }
    return { ...saved, customerName: null as string | null };
  });

  const [name] = await db().select({ name: user.name }).from(user).where(eq(user.id, updated.customerId));
  log.info("ticket.updated", { ticketId: tid, by: actor.id, version: updated.version });
  return { ...updated, customerName: name?.name ?? null };
}
