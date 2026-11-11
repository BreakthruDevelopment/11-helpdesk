import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { LIMITS } from "@/lib/tickets";
import { openTicket } from "../actions";
import { NewTicketForm } from "./new-ticket-form";

export const metadata: Metadata = { title: "Open a ticket" };
export const dynamic = "force-dynamic";

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ subject?: string }> }) {
  await requireRoleOrRedirect("user");
  const sp = await searchParams;
  const subject = typeof sp.subject === "string" ? sp.subject.slice(0, LIMITS.subjectMax) : "";

  return (
    <>
      <PageIntro
        section="Support"
        title="Open a ticket"
        description="Tell us what happened. Replies show up on the ticket and in your inbox. Nothing is emailed."
        actions={
          <Link href="/support" className={buttonSecondary}>
            Back to your tickets
          </Link>
        }
      />
      <Panel title="New ticket">
        <NewTicketForm action={openTicket} defaultSubject={subject} subjectMax={LIMITS.subjectMax} bodyMax={LIMITS.bodyMax} />
      </Panel>
    </>
  );
}
