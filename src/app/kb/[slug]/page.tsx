import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KbBody } from "@/components/kb-body";
import { formatWhen } from "@/components/format-when";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";
import { NotFoundError } from "@/lib/errors";
import { getPublished } from "@/lib/kb";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  try {
    return await getPublished(slug);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  try {
    return { title: (await getPublished(slug)).title };
  } catch {
    return { title: "Help article" };
  }
}

export default async function KbArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await load(slug);
  return (
    <>
      <PageIntro
        section="Help"
        title={article.title}
        description={`Updated ${formatWhen(article.updatedAt)}`}
        actions={
          <Link href="/kb" className={buttonSecondary}>
            All articles
          </Link>
        }
      />
      <Panel title="Article">
        {/* Markdown subset built as React elements (escaped); never HTML strings. */}
        <KbBody body={article.body} />
      </Panel>
      <Panel title="Still stuck?">
        <p className="mb-4 text-muted">Open a ticket and we&apos;ll help.</p>
        <Link href="/support/new" className={`${buttonPrimary} w-full sm:w-auto`}>
          Open a ticket
        </Link>
      </Panel>
    </>
  );
}
