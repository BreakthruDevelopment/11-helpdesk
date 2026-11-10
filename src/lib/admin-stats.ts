import "server-only";
import { count, sql } from "drizzle-orm";
import { assertAdmin } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { stampBreaches } from "@/lib/sla-db";
import { dailyCount } from "@/lib/usage";

export type AdminStats = {
  tickets: Record<(typeof schema.TICKET_STATUSES)[number], number> & { total: number };
  /** Breaches on record plus the ones nobody has looked at yet (same predicate as the lazy stamping). */
  slaBreaches: { firstResponse: number; resolution: number };
  ai: { callsToday: number; dailyCap: number };
  users: { customers: number; agents: number; admins: number };
};

/**
 * Counts only: tickets by status, SLA breaches, model calls against the cap, accounts by role. Never a subject, a
 * message, a name or an id. Admins get nothing else about tickets (access.ts).
 */
export async function adminStats(actor: Actor): Promise<AdminStats> {
  assertAdmin(actor);
  await stampBreaches(db());
  const { ticket, user } = schema;
  const byStatus = await db().select({ status: ticket.status, n: count() }).from(ticket).groupBy(ticket.status);
  const tickets = { new: 0, open: 0, pending_customer: 0, resolved: 0, total: 0 };
  for (const r of byStatus) {
    tickets[r.status] = r.n;
    tickets.total += r.n;
  }
  // The stamped columns plus the unstamped predicate, so the count is right even if the stamping hasn't run.
  const [breaches] = await db().execute<{ first: number; resolution: number }>(sql`
    select
      count(*) filter (where breached_first_response_at is not null
        or (first_responded_at is null and first_response_due_at < now()))::int as first,
      count(*) filter (where breached_resolution_at is not null
        or (resolved_at is null and paused_at is null and resolution_due_at < now()))::int as resolution
    from ticket
  `);
  const roles = await db().select({ role: user.role, n: count() }).from(user).groupBy(user.role);
  const users = { customers: 0, agents: 0, admins: 0 };
  for (const r of roles) {
    if (r.role === "admin") users.admins += r.n;
    else if (r.role === "agent") users.agents += r.n;
    else users.customers += r.n;
  }
  return {
    tickets,
    slaBreaches: { firstResponse: breaches.first, resolution: breaches.resolution },
    ai: { callsToday: await dailyCount("ai"), dailyCap: env().AI_DAILY_CAP },
    users,
  };
}
