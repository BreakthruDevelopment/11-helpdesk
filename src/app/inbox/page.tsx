import type { Metadata } from "next";
import Link from "next/link";
import { formatWhen } from "@/components/format-when";
import { PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listInbox, type InboxMessage } from "@/lib/mail/inbox";
import { markRead } from "./actions";
import { MarkReadForm } from "./mark-read-form";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const KIND: Record<InboxMessage["kind"], string> = {
  ticket_created: "Ticket received",
  agent_reply: "Reply",
  ticket_resolved: "Resolved",
  ticket_assigned: "Assigned",
  customer_reply: "Customer reply",
};

export default async function InboxPage() {
  const user = await requireUserOrRedirect();
  const inbox = await listInbox(user);
  const customer = user.role === "user";

  return (
    <>
      <PageIntro
        section="Inbox"
        title="Notifications"
        description="Replies and status changes show up here. Nothing is sent by email."
        actions={
          inbox.unread > 0 ? (
            <MarkReadForm action={markRead} label="Mark all read" pendingLabel="Saving…" all accessibleName="Mark all read" />
          ) : undefined
        }
      />
      <StatGrid>
        <StatTile value={inbox.unread} label="Unread" tone={inbox.unread > 0 ? "accent" : "default"} />
      </StatGrid>
      <Panel title="Messages" count={inbox.messages.length}>
        {inbox.messages.length === 0 ? (
          <p className="text-muted">No notifications yet. When a ticket changes, it shows up here.</p>
        ) : (
          <ul className="divide-y divide-border">
            {inbox.messages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className={m.readAt ? undefined : "font-semibold"}>
                    {customer ? (
                      <Link href={`/support/${m.ticketId}`} className="break-words text-accent hover:underline">
                        {m.subject}
                      </Link>
                    ) : (
                      <span className="break-words">{m.subject}</span>
                    )}
                  </p>
                  {m.snippet ? <p className="mt-1 break-words text-sm text-muted">{m.snippet}</p> : null}
                  <p className="mt-1 text-sm text-muted">
                    <time dateTime={m.createdAt.toISOString()}>{formatWhen(m.createdAt)}</time>
                    {" · "}
                    {KIND[m.kind]}
                    {m.readAt ? "" : " · Unread"}
                  </p>
                </div>
                {!m.readAt && (
                  <MarkReadForm
                    action={markRead}
                    id={m.id}
                    label="Mark read"
                    pendingLabel="Saving…"
                    accessibleName={`Mark read: ${m.subject}`}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
