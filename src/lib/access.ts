import { type SQL, and, eq } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { mailMessage, ticket, ticketMessage } from "@/lib/db/schema";

/**
 * Who may see what, in one place. The template's `can()` (admin passes everything) is deliberately not used here.
 *
 * | Actor    | Tickets and messages                                     | Notifications (mail_message) |
 * | -------- | -------------------------------------------------------- | ---------------------------- |
 * | customer | their own tickets, `visibility = 'public'` messages only | their own                    |
 * | agent    | every ticket, public and internal messages               | their own                    |
 * | admin    | nothing: content functions answer 404 (counts only)      | their own                    |
 *
 * Every data function starts with `contentAccess(actor)` and puts the returned fragments in its SQL, so a customer's
 * query can't match another customer's row or an internal note; the filter runs in the database, not after it.
 */
export type ContentAccess = { kind: "customer"; customerId: string } | { kind: "agent"; agentId: string };

/** Customers and agents get content access. Admins get 404: the answer a stranger would get for a missing row. */
export function contentAccess(actor: Actor): ContentAccess {
  if (actor.role === "user") return { kind: "customer", customerId: actor.id };
  if (actor.role === "agent") return { kind: "agent", agentId: actor.id };
  throw new NotFoundError();
}

/** Rows of `ticket` the actor may touch. Customers: their own. Agents: all. */
export function ticketScope(access: ContentAccess): SQL {
  return access.kind === "customer" ? eq(ticket.customerId, access.customerId) : (and() as SQL);
}

/** Rows of `ticket_message` the actor may read. Customers never match an internal note. */
export function messageScope(access: ContentAccess): SQL {
  return access.kind === "customer" ? eq(ticketMessage.visibility, "public") : (and() as SQL);
}

/** Rows of `mail_message` the actor may read: their own, whatever their role. */
export function mailScope(actor: Actor): SQL {
  return eq(mailMessage.recipientId, actor.id);
}

export function assertCustomer(actor: Actor): void {
  if (actor.role !== "user") throw new ForbiddenError("Only customers can do that.");
}

export function assertAgent(actor: Actor): void {
  if (actor.role !== "agent") throw new ForbiddenError("Only support agents can do that.");
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new ForbiddenError("Only administrators can do that.");
}
