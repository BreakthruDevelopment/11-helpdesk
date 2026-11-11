import { PageIntro } from "@/components/ui";

/** Shown in place of a public help page when the per-IP limit is hit. Carries no article data. */
export function RateLimited() {
  return (
    <PageIntro
      section="Help"
      title="Too many requests"
      description="Please wait a minute and reload this page."
    />
  );
}
