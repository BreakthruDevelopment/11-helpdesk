import { StatusBadge, type Status } from "@/components/ui";
import type { CustomerTicket } from "@/lib/tickets";

const LABEL: Record<CustomerTicket["status"], string> = {
  new: "New",
  open: "Open",
  pending_customer: "Waiting on you",
  resolved: "Resolved",
};

const TONE: Record<CustomerTicket["status"], Status> = {
  new: "building",
  open: "live",
  pending_customer: "building",
  resolved: "passed",
};

/** The customer's status, with the words as well as the color. */
export function TicketStatus({ status }: { status: CustomerTicket["status"] }) {
  return <StatusBadge status={TONE[status]} label={LABEL[status]} />;
}
