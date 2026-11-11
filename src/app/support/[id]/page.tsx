import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatWhen } from "@/components/format-when";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { LIMITS, getTicket, type CustomerMessage, type CustomerTicket } from "@/lib/tickets";
import { replyToTicket, resolveTicket } from "../actions";
import { TicketStatus } from "../ticket-status";
import { ReplyForm } from "./reply-form";
import { ResolveForm } from "./resolve-form";

export const metadata: Metadata = { title: "Ticket" };
export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRoleOrRedirect("user");
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getTicket>>;
  try {
    detail = await getTicket(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  // Customers receive the allow-list shape (public activity time as updatedAt). Anything else is not this page.
  if (!("followUp" in detail.ticket)) notFound();
  const ticket: CustomerTicket = detail.ticket;
  const messages: CustomerMessage[] = detail.messages.flatMap((m) => ("mine" in m ? [m] : []));
  const followSubject = `Follow-up: ${ticket.subject}`.slice(0, LIMITS.subjectMax);

  return (
    <>
      <PageIntro
        section="Support"
        title={ticket.subject}
        description={`#${ticket.number} · updated ${formatWhen(ticket.updatedAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <TicketStatus status={ticket.status} />
            <Link href="/support" className={buttonSecondary}>
              All tickets
            </Link>
          </div>
        }
      />
      <Panel title="Conversation" count={messages.length}>
        {messages.length === 0 ? (
          <p className="text-muted">No messages on this ticket yet.</p>
        ) : (
          <ol className="divide-y divide-border">
            {messages.map((m) => (
              <li key={m.id} className="min-w-0 py-3">
                <p className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold">{m.mine ? "You" : "Support"}</span>
                  <time dateTime={m.createdAt.toISOString()} className="text-muted">
                    {formatWhen(m.createdAt)}
                  </time>
                </p>
                {/* Plain text only. React escapes the body; do not render it as HTML. */}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      {ticket.followUp ? (
        <Panel title="This ticket is closed">
          <p className="mb-4 text-muted">
            It was resolved more than 7 days ago, so a reply here won&apos;t reopen it. Open a follow-up and we&apos;ll start a new one.
          </p>
          <Link href={`/support/new?subject=${encodeURIComponent(followSubject)}`} className={`${buttonPrimary} w-full sm:w-auto`}>
            Open a follow-up
          </Link>
        </Panel>
      ) : (
        <Panel title="Reply">
          {ticket.status === "pending_customer" && <p className="mb-4 text-muted">Support is waiting on your reply.</p>}
          <ReplyForm action={replyToTicket.bind(null, ticket.id)} bodyMax={LIMITS.bodyMax} reopen={ticket.status === "resolved"} />
        </Panel>
      )}
      {ticket.status !== "resolved" && (
        <Panel title="Resolve">
          <ResolveForm action={resolveTicket.bind(null, ticket.id)} />
        </Panel>
      )}
    </>
  );
}
