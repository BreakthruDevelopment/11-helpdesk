import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listInbox } from "@/lib/mail/inbox";
import { listTickets } from "@/lib/tickets";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const ROLE_LABEL = { user: "Customer", agent: "Agent", admin: "Admin" } as const;

/**
 * Where every signed-in user lands until the customer portal (/support) and agent desk (/desk) arrive with issues
 * 11.4 and 11.5; those pages will take this route over with a redirect. Counts come from the same data functions
 * as the API, so what a role sees here is what its access rules allow.
 */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const inbox = await listInbox(user);
  const tickets = user.role === "admin" ? null : (await listTickets(user, { limit: 100 })).tickets;
  const open = tickets?.filter((t) => t.status !== "resolved").length ?? 0;

  return (
    <>
      <PageIntro section={ROLE_LABEL[user.role]} title={`Welcome, ${user.name}`} description="The ticket portal and agent desk pages are coming. The API is live." actions={user.role === "admin" ? <Link href="/admin" className={buttonPrimary}>Admin</Link> : undefined} />
      <StatGrid>
        {tickets && <StatTile value={open} label={user.role === "agent" ? "Open tickets in the queue" : "Your open tickets"} tone="accent" />}
        <StatTile value={inbox.unread} label="Unread notifications" />
      </StatGrid>
      <Panel title="Notifications" count={inbox.messages.length}>
        {inbox.messages.length === 0 ? (
          <p className="text-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {inbox.messages.slice(0, 10).map((m) => (
              <li key={m.id} className="py-2">
                <p className={m.readAt ? "text-muted" : "font-semibold"}>{m.subject}</p>
                {m.snippet && <p className="break-words text-sm text-muted">{m.snippet}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
