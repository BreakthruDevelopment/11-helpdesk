import Link from "next/link";
import { PageIntro, Panel, buttonOutlineAccent, buttonPrimary } from "@/components/ui";

const points = [
  { title: "Two portals, one wall", body: "Customers see only their own tickets and the replies written for them. Internal notes never leave the agent desk." },
  { title: "Honest SLA clocks", body: "Due times are set by the server, the clock pauses while we wait on the customer, and breaches are recorded." },
  { title: "Notifications in the app", body: "Replies and status changes land in an in-app inbox. No email is sent from this demo." },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Helpdesk"
        title="Support tickets you own."
        description="Customers open tickets in a portal; agents work a queue with SLA clocks. A demo of a self-hosted Zendesk alternative."
        actions={
          <>
            <Link href="/support" className={buttonPrimary}>
              Support portal
            </Link>
            <Link href="/kb" className={buttonOutlineAccent}>
              Help articles
            </Link>
            <Link href="/sign-in" className={buttonOutlineAccent}>
              Sign in
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-3">
        {points.map((p) => (
          <Panel key={p.title} title={p.title}>
            <p className="text-muted">{p.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
