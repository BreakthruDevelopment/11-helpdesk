import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { formatWhen } from "@/components/format-when";
import { FilterBar, PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { searchPublished } from "@/lib/kb";
import { stripMarkdown } from "@/lib/kb-markdown";

export const metadata: Metadata = { title: "Help articles" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

type Search = { q?: string; offset?: string };

export default async function KbPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  // Same limits as the API (200 chars, no NUL). Anything odd falls back to listing instead of a 500.
  const q = typeof sp.q === "string" ? sp.q.replaceAll("\0", "").trim().slice(0, 200) : "";
  const parsed = Number(typeof sp.offset === "string" ? sp.offset : "0");
  const offset = Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 0;
  const result = await searchPublished({ q, limit: PAGE_SIZE, offset }).catch((err: unknown) => {
    if (err instanceof ZodError) return searchPublished({ limit: PAGE_SIZE, offset });
    throw err;
  });

  const href = (nextOffset: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (nextOffset > 0) params.set("offset", String(nextOffset));
    const s = params.toString();
    return s ? `/kb?${s}` : "/kb";
  };

  return (
    <>
      <PageIntro
        section="Help"
        title="Help articles"
        description="Answers to common questions. If you can't find yours, open a ticket."
        actions={
          <Link href="/support/new" className={buttonSecondary}>
            Open a ticket
          </Link>
        }
      />
      <FilterBar label="Search help articles" search={{ value: q, placeholder: "Search help articles" }} />
      <Panel title={q ? "Results" : "Latest articles"} count={result.articles.length}>
        {result.articles.length === 0 ? (
          <p className="text-muted">{q ? "No articles match that search." : offset > 0 ? "No articles on this page." : "No articles yet."}</p>
        ) : (
          <ul className="divide-y divide-border">
            {result.articles.map((a) => (
              <li key={a.id} className="min-w-0 py-3">
                <Link href={`/kb/${a.slug}`} className="font-semibold break-words text-accent hover:underline">
                  {a.title}
                </Link>
                {/* Plain text only: Markdown markers are stripped and React escapes the rest. */}
                <p className="mt-1 break-words text-muted">{stripMarkdown(a.excerpt)}</p>
                <p className="mt-1 text-sm text-muted">
                  Updated <time dateTime={a.updatedAt.toISOString()}>{formatWhen(a.updatedAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {(offset > 0 || result.hasMore) && (
        <nav aria-label="Article pages" className="mt-4 flex flex-wrap gap-3">
          {offset > 0 && (
            <Link href={href(Math.max(0, offset - PAGE_SIZE))} className={buttonSecondary}>
              Previous
            </Link>
          )}
          {result.hasMore && result.nextOffset !== null && (
            <Link href={href(result.nextOffset)} className={buttonSecondary}>
              Next
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
