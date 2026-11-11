import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { KB_LIMITS } from "@/lib/kb";
import { createArticleAction } from "../actions";
import { ArticleForm } from "../article-form";

export const metadata: Metadata = { title: "New article" };
export const dynamic = "force-dynamic";

export default async function NewArticlePage() {
  await requireRoleOrRedirect("agent");
  return (
    <>
      <PageIntro
        section="Knowledge base"
        title="New article"
        description="Save it as a draft to keep it private, or publish it for customers."
        actions={
          <Link href="/desk/kb" className={buttonSecondary}>
            All articles
          </Link>
        }
      />
      <Panel title="Article">
        <ArticleForm action={createArticleAction} initial={{ title: "", body: "" }} status={null} limits={KB_LIMITS} />
      </Panel>
    </>
  );
}
