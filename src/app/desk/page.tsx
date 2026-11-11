import type { Metadata } from "next";
import Link from "next/link";
import { formatWhen } from "@/components/format-when";
import { DataList, FilterBar, PageIntro, StatGrid, StatTile, buttonSecondary, type Column } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { TICKET_STATUSES } from "@/lib/db/schema";
import { CATEGORY_LABEL, PRIORITY_LABEL, QUEUE_VIEWS, STATUS_LABEL, queueView } from "@/lib/desk-view";
import { countOpenTickets, listTickets, type AgentTicket } from "@/lib/tickets";
import { DeskStatus, SlaChip, Tag } from "./badges";
import { Countdown } from "./countdown";

export const metadata: Metadata = { title: "Desk" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type Search = { view?: string; status?: string; offset?: string };

function parseQuery(sp: Search) {
  const status = TICKET_STATUSES.find((s) => s === sp.status);
  const parsed = Number(sp.offset ?? "0");
  const offset = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : 0;
  return { view: queueView(sp.view), status, offset };
}

function href(view: string, status: string | undefined, offset = 0) {
  const p = new URLSearchParams({ view });
  if (status) p.set("status", status);
  if (offset > 0) p.set("offset", String(offset));
  return `/desk?${p.toString()}`;
}

/** The agent queue: Unassigned, Mine or All, soonest SLA deadline first (the data layer's order), with SLA chips. */
export default async function DeskPage({ searchParams }: { searchParams: Promise<Search> }) {
  const agent = await requireRoleOrRedirect("agent");
  const { view, status, offset } = parseQuery(await searchParams);
  const [open, result] = await Promise.all([countOpenTickets(agent), listTickets(agent, { view, status, limit: PAGE_SIZE, offset })]);
  // listTickets is typed as the customer or the agent shape; agents always get the agent shape.
  const tickets = result.tickets.filter((t): t is AgentTicket => "sla" in t);
  const breached = tickets.filter((t) => t.sla.state === "breached").length;
  const atRisk = tickets.filter((t) => t.sla.state === "at_risk").length;

  const columns: Column<AgentTicket>[] = [
    {
      key: "subject",
      header: "Ticket",
      primary: true,
      cell: (t) => (
        <span className="block min-w-0">
          <Link href={`/desk/${t.id}`} className="inline-flex min-h-11 items-center font-semibold break-words text-accent hover:underline">
            #{t.number} {t.subject}
          </Link>
          <span className="block text-sm text-muted break-words">{t.customerName ?? "Customer"}</span>
        </span>
      ),
    },
    {
      key: "sla",
      header: "SLA",
      cell: (t) => (
        <span className="flex flex-col items-start gap-1">
          <SlaChip state={t.sla.state} />
          <span className="text-sm">
            <Countdown due={t.sla.nextDueAt ? t.sla.nextDueAt.toISOString() : null} />
          </span>
        </span>
      ),
    },
    { key: "status", header: "Status", cell: (t) => <DeskStatus status={t.status} /> },
    {
      key: "priority",
      header: "Priority",
      cell: (t) => (
        <span className="flex flex-wrap gap-1">
          <Tag>{PRIORITY_LABEL[t.priority]}</Tag>
          <Tag>{CATEGORY_LABEL[t.category]}</Tag>
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      cell: (t) => (t.assigneeId === null ? <span className="text-muted">Unassigned</span> : t.assigneeId === agent.id ? "You" : "Another agent"),
    },
    {
      key: "created",
      header: "Opened",
      className: "whitespace-nowrap",
      cell: (t) => <time dateTime={t.createdAt.toISOString()}>{formatWhen(t.createdAt)}</time>,
    },
  ];

  return (
    <>
      <PageIntro section="Desk" title="Ticket queue" description="Soonest SLA deadline first. Open a ticket to reply, add a note or change its properties." />
      <StatGrid>
        <StatTile value={open} label="Open tickets" tone="accent" />
        <StatTile value={breached} label="Breached on this page" tone={breached > 0 ? "blocked" : "default"} />
        <StatTile value={atRisk} label="At risk on this page" tone={atRisk > 0 ? "building" : "default"} />
      </StatGrid>

      <nav aria-label="Queue views" className="mb-4 flex flex-wrap gap-2">
        {QUEUE_VIEWS.map((v) => (
          <Link
            key={v.value}
            href={href(v.value, status)}
            aria-current={v.value === view ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-card border px-4 text-sm font-semibold ${
              v.value === view ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground hover:bg-accent-soft"
            }`}
          >
            {v.label}
          </Link>
        ))}
      </nav>

      <FilterBar
        label="Filter tickets"
        hidden={{ view }}
        filters={[
          {
            name: "status",
            label: "Status",
            value: status ?? "",
            options: [{ value: "", label: "Any status" }, ...TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))],
          },
        ]}
      />

      <section aria-label="Tickets" className="rounded-card border border-border bg-surface p-4 sm:p-6">
        <DataList
          caption={`${QUEUE_VIEWS.find((v) => v.value === view)?.label} tickets`}
          rows={tickets}
          rowKey={(t) => t.id}
          columns={columns}
          empty={
            view === "unassigned"
              ? "Nothing waiting for an owner. Check Mine or All."
              : view === "mine"
                ? "No tickets are assigned to you. Pick one up from Unassigned."
                : "No tickets match this filter."
          }
        />
        {(offset > 0 || result.hasMore) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {offset > 0 && (
              <Link href={href(view, status, Math.max(0, offset - PAGE_SIZE))} className={buttonSecondary}>
                Previous page
              </Link>
            )}
            {result.hasMore && result.nextOffset !== null && (
              <Link href={href(view, status, result.nextOffset)} className={buttonSecondary}>
                Next page
              </Link>
            )}
          </div>
        )}
      </section>
    </>
  );
}
