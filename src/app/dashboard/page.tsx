import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listInbox } from "@/lib/mail/inbox";
import { countOpenTickets } from "@/lib/tickets";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const ROLE_LABEL = { agent: "Agent", admin: "Admin" } as const;

/**
 * Agents land here until the desk (/desk) arrives with issue 11.5. Customers are sent to the portal.
 * Counts come from the same data functions as the API, so what a role sees here is what its access rules allow.
 */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  if (user.role === "user") redirect("/support");
  const inbox = await listInbox(user);
  const open = user.role === "agent" ? await countOpenTickets(user) : null;

  return (
    <>
      <PageIntro
        section={ROLE_LABEL[user.role]}
        title={`Welcome, ${user.name}`}
        description={user.role === "admin" ? "Counts and accounts live on the admin page." : "The agent desk is coming. Notifications for your tickets are below."}
        actions={
          user.role === "admin" ? (
            <Link href="/admin" className={buttonPrimary}>
              Admin
            </Link>
          ) : undefined
        }
      />
      <StatGrid>
        {open !== null && <StatTile value={open} label="Open tickets in the queue" tone="accent" />}
        <StatTile value={inbox.unread} label="Unread notifications" />
      </StatGrid>
      <Panel
        title="Notifications"
        count={inbox.messages.length}
        action={
          <Link href="/inbox" className={buttonSecondary}>
            Inbox
          </Link>
        }
      >
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
