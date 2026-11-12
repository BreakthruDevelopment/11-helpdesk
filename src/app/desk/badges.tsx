import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import { SLA_LABEL, SLA_TONE, STATUS_LABEL, STATUS_TONE, type SlaState, type TicketStatus } from "@/lib/desk-view";

/** The SLA chip: the state in words as well as color. */
export function SlaChip({ state }: { state: SlaState }) {
  return <StatusBadge status={SLA_TONE[state]} label={`SLA: ${SLA_LABEL[state]}`} />;
}

export function DeskStatus({ status }: { status: TicketStatus }) {
  return <StatusBadge status={STATUS_TONE[status]} label={STATUS_LABEL[status]} />;
}

/** A small neutral tag, for priority and category. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-sm text-foreground">{children}</span>;
}

/** A "needs a human" flag with the model's reason. Wraps (unlike StatusBadge), since the reason can be a sentence. */
export function NeedsHuman({ reason }: { reason: string }) {
  return (
    <span className="inline-flex max-w-full items-start gap-1.5 rounded-md bg-blocked-soft px-2 py-0.5 text-sm font-medium text-blocked">
      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-blocked" />
      <span className="min-w-0 break-words">Needs human: {reason}</span>
    </span>
  );
}
