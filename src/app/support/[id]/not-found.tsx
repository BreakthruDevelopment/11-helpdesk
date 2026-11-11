import Link from "next/link";
import { PageIntro } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";

export default function TicketNotFound() {
  return (
    <>
      <PageIntro
        section="Support"
        title="Ticket not found"
        description="That ticket isn't in your account. It may have been removed, or the link is wrong."
      />
      <Link href="/support" className={buttonPrimary}>
        Back to your tickets
      </Link>
    </>
  );
}
