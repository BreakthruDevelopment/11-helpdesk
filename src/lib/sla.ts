import type { TICKET_PRIORITIES } from "@/lib/db/schema";

/**
 * SLA arithmetic, pure functions. Calendar hours (business hours are out of scope).
 *
 * Windows, due times, pause/resume and priority change (11.1), and the state computed on every read (11.2).
 */
export type Priority = (typeof TICKET_PRIORITIES)[number];

/** Hours allowed for a first public agent response and for resolution, by priority. */
export const SLA_HOURS: Record<Priority, { firstResponse: number; resolution: number }> = {
  urgent: { firstResponse: 1, resolution: 8 },
  high: { firstResponse: 4, resolution: 24 },
  normal: { firstResponse: 8, resolution: 72 },
  low: { firstResponse: 24, resolution: 120 },
};

const HOUR_MS = 3_600_000;

export function firstResponseDueAt(priority: Priority, createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[priority].firstResponse * HOUR_MS);
}

/** Created time plus the window plus every second the ticket spent waiting on the customer. */
export function resolutionDueAt(priority: Priority, createdAt: Date, pausedSeconds: number): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[priority].resolution * HOUR_MS + Math.max(0, pausedSeconds) * 1000);
}

/** Whole seconds the clock was paused, from `pausedAt` until `now` (never negative). */
export function pausedFor(pausedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - pausedAt.getTime()) / 1000));
}

// ---------------------------------------------------------------------------
// Pause, resume and priority change (the transitions tickets.ts applies)
// ---------------------------------------------------------------------------

type ClockFields = { pausedAt: Date | null; pausedSeconds: number; resolutionDueAt: Date };

/**
 * Leaving `pending_customer` (an agent moves it on, or the customer replies): the time spent waiting moves the
 * resolution deadline later by the same amount and the clock runs again. A ticket that wasn't paused is unchanged.
 */
export function resumeClock(row: ClockFields, now: Date): { pausedAt: null; pausedSeconds: number; resolutionDueAt: Date } {
  if (!row.pausedAt) return { pausedAt: null, pausedSeconds: row.pausedSeconds, resolutionDueAt: row.resolutionDueAt };
  const elapsed = pausedFor(row.pausedAt, now);
  return {
    pausedAt: null,
    pausedSeconds: row.pausedSeconds + elapsed,
    resolutionDueAt: new Date(row.resolutionDueAt.getTime() + elapsed * 1000),
  };
}

/** Both due times for a priority, always from `created_at` (never from "now", so repeated changes can't compound). */
export function dueTimes(priority: Priority, createdAt: Date, pausedSeconds: number): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  return { firstResponseDueAt: firstResponseDueAt(priority, createdAt), resolutionDueAt: resolutionDueAt(priority, createdAt, pausedSeconds) };
}

// ---------------------------------------------------------------------------
// State, computed on every read
// ---------------------------------------------------------------------------

export type ClockState = "ok" | "at_risk" | "breached" | "met" | "paused";

/** At risk means less than this share of the window is left. */
export const AT_RISK_FRACTION = 0.25;

export type SlaTicket = {
  status: "new" | "open" | "pending_customer" | "resolved";
  priority: Priority;
  createdAt: Date;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  pausedAt: Date | null;
  pausedSeconds: number;
  breachedFirstResponseAt: Date | null;
  breachedResolutionAt: Date | null;
};

function running(due: Date, windowMs: number, now: Date): "ok" | "at_risk" | "breached" {
  const left = due.getTime() - now.getTime();
  if (left < 0) return "breached";
  return left < windowMs * AT_RISK_FRACTION ? "at_risk" : "ok";
}

/**
 * The first-response clock. Met by the first public agent message; a reply (or a resolution) after the deadline is
 * still a breach. A recorded breach always wins, so the answer never contradicts the stamped column.
 */
export function firstResponseState(t: SlaTicket, now: Date): ClockState {
  const end = t.firstRespondedAt ?? t.resolvedAt;
  if (t.breachedFirstResponseAt) return "breached";
  if (end) return end.getTime() > t.firstResponseDueAt.getTime() ? "breached" : "met";
  return running(t.firstResponseDueAt, SLA_HOURS[t.priority].firstResponse * HOUR_MS, now);
}

/** The resolution clock: `paused` while the ticket waits on the customer, `met` once resolved in time. */
export function resolutionState(t: SlaTicket, now: Date): ClockState {
  if (t.breachedResolutionAt) return "breached";
  if (t.resolvedAt) return t.resolvedAt.getTime() > t.resolutionDueAt.getTime() ? "breached" : "met";
  if (t.pausedAt) return "paused";
  return running(t.resolutionDueAt, SLA_HOURS[t.priority].resolution * HOUR_MS, now);
}

export type SlaState = "ok" | "at_risk" | "breached" | "met" | "paused";

/**
 * One state for the ticket, for the chip in the queue: breached if either clock breached; otherwise at risk if
 * either is; a resolved ticket is `met`; a ticket waiting on the customer is `paused`; everything else is `ok`.
 * Computed from the row and `now` on every read; the stamped breach columns only make it agree with history.
 */
export function slaState(t: SlaTicket, now: Date): SlaState {
  const first = firstResponseState(t, now);
  const resolution = resolutionState(t, now);
  if (first === "breached" || resolution === "breached") return "breached";
  if (t.status === "resolved") return "met";
  if (first === "at_risk" || resolution === "at_risk") return "at_risk";
  if (resolution === "paused") return "paused";
  return "ok";
}

/**
 * The deadline an agent should act on next, or null when nothing is ticking (resolved, or waiting on the customer
 * with the first response already sent). Matches the queue's ORDER BY in sla-db.ts.
 */
export function nextDueAt(t: SlaTicket): Date | null {
  if (t.status === "resolved") return null;
  if (!t.firstRespondedAt) return t.firstResponseDueAt;
  return t.pausedAt ? null : t.resolutionDueAt;
}

export type TicketSla = {
  state: SlaState;
  firstResponse: ClockState;
  resolution: ClockState;
  /** What the countdown shows; null when nothing is ticking. */
  nextDueAt: Date | null;
};

export function slaView(t: SlaTicket, now: Date): TicketSla {
  return { state: slaState(t, now), firstResponse: firstResponseState(t, now), resolution: resolutionState(t, now), nextDueAt: nextDueAt(t) };
}
