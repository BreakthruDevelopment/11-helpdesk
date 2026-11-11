import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatWhen } from "@/components/format-when";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { KB_LIMITS, getArticle } from "@/lib/kb";
import { deleteArticleAction, saveArticleAction } from "../actions";
import { ArticleForm } from "../article-form";
import { DeleteArticleForm } from "../delete-form";
import { ArticleStatus } from "../article-status";

export const metadata: Metadata = { title: "Edit article" };
export const dynamic = "force-dynamic";

export default async function EditArticlePage({ params, searchParams }: PageProps<"/desk/kb/[id]">) {
  const agent = await requireRoleOrRedirect("agent");
  const { id } = await params;
  const sp = await searchParams;
  let article: Awaited<ReturnType<typeof getArticle>>;
  try {
    article = await getArticle(agent, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  return (
    <>
      <PageIntro
        section="Knowledge base"
        title={article.title}
        description={`/kb/${article.slug} · updated ${formatWhen(article.updatedAt)}${article.authorName ? ` · by ${article.authorName}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <ArticleStatus status={article.status} />
            {article.status === "published" && (
              <Link href={`/kb/${article.slug}`} className={buttonSecondary}>
                View public page
              </Link>
            )}
            <Link href="/desk/kb" className={buttonSecondary}>
              All articles
            </Link>
          </div>
        }
      />
      {sp.saved === "1" && (
        <p role="status" className="mb-4 rounded-card border border-border bg-live-soft px-4 py-3 text-live">
          Saved{article.status === "published" ? " and published" : " as a draft"}.
        </p>
      )}
      <Panel title="Article">
        <ArticleForm
          key={article.updatedAt.toISOString()}
          action={saveArticleAction.bind(null, article.id)}
          initial={{ title: article.title, body: article.body }}
          status={article.status}
          limits={KB_LIMITS}
        />
      </Panel>
      <Panel title="Delete">
        <DeleteArticleForm action={deleteArticleAction.bind(null, article.id)} />
      </Panel>
    </>
  );
}
