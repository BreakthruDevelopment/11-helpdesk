import type { TICKET_PRIORITIES } from "@/lib/db/schema";

/**
 * SLA arithmetic, pure functions. Calendar hours (business hours are out of scope).
 *
 * Issue 11.1 needs only what ticket creation and the status rules call: the windows, the due times, and the
 * pause rule. `slaState()`, the queue ordering and the lazy-stamping tests are issue 11.2.
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
