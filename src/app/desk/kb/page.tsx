import type { Metadata } from "next";
import Link from "next/link";
import { formatWhen } from "@/components/format-when";
import { DataList, FilterBar, PageIntro, buttonPrimary, buttonSecondary, type Column } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { KB_STATUSES } from "@/lib/db/schema";
import { KB_LIMITS, listArticles, type AgentArticle } from "@/lib/kb";
import { ArticleStatus } from "./article-status";

export const metadata: Metadata = { title: "Knowledge base editor" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Search = { q?: string; status?: string; offset?: string; deleted?: string };

function parse(sp: Search) {
  const status = KB_STATUSES.find((s) => s === sp.status);
  const q = typeof sp.q === "string" ? sp.q.slice(0, KB_LIMITS.queryMax) : "";
  const n = Number(sp.offset ?? "0");
  const offset = Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
  return { status, q, offset };
}

function href(q: string, status: string | undefined, offset: number) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status) p.set("status", status);
  if (offset > 0) p.set("offset", String(offset));
  const s = p.toString();
  return s ? `/desk/kb?${s}` : "/desk/kb";
}

/** Every article, drafts included, newest edit first (best match first when searching). */
export default async function KbEditorPage({ searchParams }: { searchParams: Promise<Search> }) {
  const agent = await requireRoleOrRedirect("agent");
  const sp = await searchParams;
  const { status, q, offset } = parse(sp);
  const result = await listArticles(agent, { q, status, limit: PAGE_SIZE, offset });

  const columns: Column<AgentArticle>[] = [
    {
      key: "title",
      header: "Article",
      primary: true,
      cell: (a) => (
        <span className="block min-w-0">
          <Link href={`/desk/kb/${a.id}`} className="inline-flex min-h-11 items-center font-semibold break-words text-accent hover:underline">
            {a.title}
          </Link>
          <span className="block break-all text-sm text-muted">/kb/{a.slug}</span>
        </span>
      ),
    },
    { key: "status", header: "Status", cell: (a) => <ArticleStatus status={a.status} /> },
    { key: "author", header: "Author", cell: (a) => a.authorName ?? <span className="text-muted">Unknown</span> },
    {
      key: "updated",
      header: "Updated",
      className: "whitespace-nowrap",
      cell: (a) => <time dateTime={a.updatedAt.toISOString()}>{formatWhen(a.updatedAt)}</time>,
    },
  ];

  return (
    <>
      <PageIntro
        section="Desk"
        title="Knowledge base"
        description="Write, publish and retire help articles. Only published articles reach customers, search and AI replies."
        actions={
          <Link href="/desk/kb/new" className={buttonPrimary}>
            New article
          </Link>
        }
      />
      {sp.deleted === "1" && (
        <p role="status" className="mb-4 rounded-card border border-border bg-live-soft px-4 py-3 text-live">
          Article deleted.
        </p>
      )}
      <FilterBar
        label="Filter articles"
        search={{ value: q, placeholder: "Search articles…" }}
        filters={[
          {
            name: "status",
            label: "Status",
            value: status ?? "",
            options: [
              { value: "", label: "Any status" },
              { value: "draft", label: "Drafts" },
              { value: "published", label: "Published" },
            ],
          },
        ]}
      />
      <section aria-label="Articles" className="rounded-card border border-border bg-surface p-4 sm:p-6">
        <DataList
          caption="Articles"
          rows={result.articles}
          rowKey={(a) => a.id}
          columns={columns}
          empty={q || status ? "No articles match this filter." : "No articles yet. Write the first one."}
        />
        {(offset > 0 || result.hasMore) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {offset > 0 && (
              <Link href={href(q, status, Math.max(0, offset - PAGE_SIZE))} className={buttonSecondary}>
                Previous page
              </Link>
            )}
            {result.hasMore && result.nextOffset !== null && (
              <Link href={href(q, status, result.nextOffset)} className={buttonSecondary}>
                Next page
              </Link>
            )}
          </div>
        )}
      </section>
    </>
  );
}
