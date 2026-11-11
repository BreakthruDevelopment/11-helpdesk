import "server-only";
import { sql } from "drizzle-orm";
import type { Executor } from "@/lib/usage";

/**
 * The unstamped first-response breach, shared with the admin counts so the two can never disagree: no public agent
 * reply yet, the deadline has passed, and the ticket wasn't resolved before the deadline (resolving ends the
 * obligation, so a ticket closed in time is not a breach; one closed late, or still open, is).
 */
export const FIRST_RESPONSE_OVERDUE = sql`first_responded_at is null and first_response_due_at < now()
  and (resolved_at is null or resolved_at > first_response_due_at)`;

/**
 * Lazy breach stamping: record SLA breaches without a scheduler. Idempotent (only rows still unstamped change) and
 * safe to run from any read or write. Run it BEFORE stamping a first response or a resolution, so a late one still
 * leaves its breach on record. The resolution clock is paused (not breaching) while `paused_at` is set.
 */
export async function stampBreaches(tx: Pick<Executor, "execute">): Promise<void> {
  await tx.execute(sql`
    update ticket set breached_first_response_at = first_response_due_at
    where breached_first_response_at is null and ${FIRST_RESPONSE_OVERDUE}
  `);
  await tx.execute(sql`
    update ticket set breached_resolution_at = resolution_due_at
    where breached_resolution_at is null and resolved_at is null and paused_at is null and resolution_due_at < now()
  `);
}

/**
 * The agent queue's ORDER BY, the SQL twin of `nextDueAt()` in sla.ts: tickets with a clock running come first, the
 * soonest deadline at the top (an unanswered ticket by its first-response deadline, an answered one by its resolution
 * deadline); then tickets waiting on the customer with nothing ticking; resolved tickets last. Spread it into
 * `.orderBy(...queueOrder(), asc(ticket.id))` so pages stay stable.
 */
export function queueOrder() {
  return [
    sql`(case
      when status = 'resolved' then 2
      when first_responded_at is not null and paused_at is not null then 1
      else 0 end) asc`,
    sql`(case when first_responded_at is null then first_response_due_at else resolution_due_at end) asc`,
  ] as const;
}
