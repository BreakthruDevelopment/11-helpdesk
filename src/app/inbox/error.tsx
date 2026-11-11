"use client";

import { PageIntro } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";

export default function InboxError({ retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert">
      <PageIntro
        section="Inbox"
        title="We couldn't load your notifications."
        description="Try again. If it keeps happening, come back in a few minutes."
      />
      <button type="button" onClick={() => retry()} className={buttonPrimary}>
        Try again
      </button>
    </div>
  );
}
