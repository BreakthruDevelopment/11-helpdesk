import Link from "next/link";
import { PageIntro } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";

export default function ArticleNotFound() {
  return (
    <>
      <PageIntro section="Help" title="Article not found" description="That article doesn't exist, or it isn't published." />
      <Link href="/kb" className={buttonPrimary}>
        Browse help articles
      </Link>
    </>
  );
}
