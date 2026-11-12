"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { buttonSecondary } from "@/components/ui/styles";
import type { ArticleRef } from "@/lib/support-ai";
import { useComposer } from "./composer-context";

/** "Add link to reply" for a suggested article: it goes into the reply box for the agent to send, never on its own. */
export function AddArticleLink({ article }: { article: ArticleRef }) {
  const { addArticle } = useComposer();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link href={`/kb/${article.slug}`} target="_blank" className="inline-flex min-h-11 min-w-0 items-center break-words text-accent underline">
        {article.title}
      </Link>
      <button type="button" onClick={() => addArticle(article)} className={buttonSecondary}>
        Add link to reply
      </button>
    </div>
  );
}

export function RetriageButton({ action, left }: { action: () => Promise<{ error: string | null }>; left: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending || left === 0}
        onClick={() => {
          setError(null);
          start(async () => setError((await action()).error));
        }}
        className={`${buttonSecondary} w-full sm:w-auto`}
      >
        {pending ? "Re-running…" : left === 0 ? "No re-triages left" : `Re-run triage (${left} left)`}
      </button>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

