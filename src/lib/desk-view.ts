/**
 * Pure display helpers for the agent desk: words and tones for SLA states, ticket statuses, priorities and
 * categories, the countdown text, and which triage suggestions differ from the ticket. No data access here, so
 * client and server components share it and it is unit-tested on its own.
 */
import type { Status } from "@/components/ui/StatusBadge";

export type SlaState = "ok" | "at_risk" | "breached" | "met" | "paused";
export type TicketStatus = "new" | "open" | "pending_customer" | "resolved";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketCategory = "billing" | "technical" | "account" | "how_to" | "bug" | "feature_request" | "other";

export const SLA_LABEL: Record<SlaState, string> = {
  ok: "On track",
  at_risk: "At risk",
  breached: "Breached",
  met: "Met",
  paused: "Paused",
};

export const SLA_TONE: Record<SlaState, Status> = {
  ok: "live",
  at_risk: "building",
  breached: "blocked",
  met: "passed",
  paused: "not-started",
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending_customer: "Waiting on customer",
  resolved: "Resolved",
};

export const STATUS_TONE: Record<TicketStatus, Status> = {
  new: "building",
  open: "live",
  pending_customer: "not-started",
  resolved: "passed",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  billing: "Billing",
  technical: "Technical",
  account: "Account",
  how_to: "How-to",
  bug: "Bug",
  feature_request: "Feature request",
  other: "Other",
};

/** Where an agent may move a ticket from each status (mirrors the data layer; `new` is never a target). */
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  new: ["open", "pending_customer", "resolved"],
  open: ["pending_customer", "resolved"],
  pending_customer: ["open", "resolved"],
  resolved: ["open"],
};

export const QUEUE_VIEWS = [
  { value: "unassigned", label: "Unassigned" },
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number]["value"];

/** The `view` search param, defaulting to Unassigned (the work nobody has picked up). */
export function queueView(raw: unknown): QueueView {
  return raw === "mine" || raw === "all" || raw === "unassigned" ? raw : "unassigned";
}

const MINUTE = 60_000;

/** "in 3h 20m", "in 45m", "12m overdue", "2d 4h overdue". Null due means nothing is ticking. */
export function countdown(due: Date | string | null, now: Date): string | null {
  if (due === null) return null;
  const ms = new Date(due).getTime() - now.getTime();
  const overdue = ms < 0;
  const minutes = Math.max(0, Math.floor(Math.abs(ms) / MINUTE));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (overdue) return `${text} overdue`;
  return minutes === 0 ? "due now" : `in ${text}`;
}

/** Which of the triage's suggestions differ from what the ticket has now: only those get an "Apply" button. */
export function triageDiff(
  ticket: { category: TicketCategory; priority: TicketPriority },
  triage: { category: TicketCategory; priority: TicketPriority },
): { category: TicketCategory | null; priority: TicketPriority | null } {
  return {
    category: triage.category !== ticket.category ? triage.category : null,
    priority: triage.priority !== ticket.priority ? triage.priority : null,
  };
}

/** Appends "Title: /kb/slug" for a suggested article to the reply text, on its own line, once. */
export function withArticleLink(body: string, article: { title: string; slug: string }, origin = ""): string {
  const line = `${article.title}: ${origin}/kb/${article.slug}`;
  if (body.includes(line)) return body;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${line}` : line;
}
