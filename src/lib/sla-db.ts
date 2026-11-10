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
