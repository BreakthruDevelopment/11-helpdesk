import type { Metadata } from "next";
import Link from "next/link";
import { formatWhen } from "@/components/format-when";
import { DataList, FilterBar, PageIntro, StatGrid, StatTile, buttonPrimary, buttonSecondary, type Column } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { TICKET_STATUSES } from "@/lib/db/schema";
import { countOpenTickets, listTickets, type CustomerTicket } from "@/lib/tickets";
import { TicketStatus } from "./ticket-status";

export const metadata: Metadata = { title: "Your tickets" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type Search = { status?: string; offset?: string };

function parseListQuery(sp: Search) {
  const status = TICKET_STATUSES.find((s) => s === sp.status);
  const parsed = Number(sp.offset ?? "0");
  const offset = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : 0;
  return { status, offset };
}

export default async function SupportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireRoleOrRedirect("user");
  const { status, offset } = parseListQuery(await searchParams);
  const [open, result] = await Promise.all([
    countOpenTickets(user),
    listTickets(user, { status, limit: PAGE_SIZE, offset }),
  ]);
  // listTickets is typed as the customer shape or the agent shape. This page is customers only.
  const tickets = result.tickets.filter((t): t is CustomerTicket => "followUp" in t);

  const columns: Column<CustomerTicket>[] = [
    {
      key: "subject",
      header: "Subject",
      primary: true,
      cell: (t) => (
        <Link href={`/support/${t.id}`} className="font-semibold break-words text-accent hover:underline">
          {t.subject}
        </Link>
      ),
    },
    {
      key: "number",
      header: "Number",
      cell: (t) => <span className="font-mono text-sm">#{t.number}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <TicketStatus status={t.status} />,
    },
    {
      key: "updated",
      header: "Updated",
      className: "whitespace-nowrap",
      cell: (t) => <time dateTime={t.updatedAt.toISOString()}>{formatWhen(t.updatedAt)}</time>,
    },
  ];

  const query = (nextOffset: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (nextOffset > 0) params.set("offset", String(nextOffset));
    const q = params.toString();
    return q ? `/support?${q}` : "/support";
  };

  const empty = status ? "No tickets with that status." : offset > 0 ? "No tickets on this page." : "You have no tickets yet.";

  return (
    <>
      <PageIntro
        section="Support"
        title="Your tickets"
        description="Tickets you opened, and the replies written for you. Internal notes stay on the agent desk."
        actions={
          <Link href="/support/new" className={buttonPrimary}>
            Open a ticket
          </Link>
        }
      />
      <StatGrid>
        <StatTile value={open} label="Still open" tone="accent" />
      </StatGrid>
      <FilterBar
        label="Filter tickets"
        filters={[
          {
            name: "status",
            label: "Status",
            value: status ?? "",
            options: [
              { value: "", label: "All statuses" },
              { value: "new", label: "New" },
              { value: "open", label: "Open" },
              { value: "pending_customer", label: "Waiting on you" },
              { value: "resolved", label: "Resolved" },
            ],
          },
        ]}
      />
      <DataList columns={columns} rows={tickets} rowKey={(t) => t.id} caption="Your tickets" empty={empty} />
      {(offset > 0 || result.hasMore) && (
        <nav aria-label="Ticket pages" className="mt-4 flex flex-wrap gap-3">
          {offset > 0 && (
            <Link href={query(Math.max(0, offset - PAGE_SIZE))} className={buttonSecondary}>
              Previous
            </Link>
          )}
          {result.hasMore && result.nextOffset !== null && (
            <Link href={query(result.nextOffset)} className={buttonSecondary}>
              Next
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
