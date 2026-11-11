import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listInbox } from "@/lib/mail/inbox";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/**
 * Sign-in lands here and each role is sent on: customers to the portal, agents to the desk. Admins see their
 * notifications and a link to the admin page.
 */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  if (user.role === "user") redirect("/support");
  if (user.role === "agent") redirect("/desk");
  const inbox = await listInbox(user);

  return (
    <>
      <PageIntro
        section="Admin"
        title={`Welcome, ${user.name}`}
        description="Counts and accounts live on the admin page."
        actions={
          <Link href="/admin" className={buttonPrimary}>
            Admin
          </Link>
        }
      />
      <StatGrid>
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
