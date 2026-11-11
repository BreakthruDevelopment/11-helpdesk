"use client";

import { useActionState, useState } from "react";
import { KbBody } from "@/components/kb-body";
import { buttonOutlineAccent, buttonPrimary, buttonSecondary, inputClass, labelClass, textareaClass } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

/**
 * Title and body with a live preview through the same KbBody the public pages use. The buttons say what happens:
 * save as it is, publish, or unpublish (back to draft).
 */
export function ArticleForm({
  action,
  initial,
  status,
  limits,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: { title: string; body: string };
  status: "draft" | "published" | null;
  limits: { titleMax: number; bodyMax: number };
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tab, setTab] = useState<"write" | "preview">("write");

  return (
    <form action={formAction} className="space-y-4">
      <label className={labelClass}>
        <span>Title</span>
        <input name="title" required maxLength={limits.titleMax} value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending} className={inputClass} />
      </label>

      <div className="flex gap-2 lg:hidden" role="group" aria-label="Editor view">
        {(["write", "preview"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-card border px-4 text-sm font-semibold capitalize ${
              tab === t ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className={`${labelClass} ${tab === "preview" ? "max-lg:hidden" : ""}`}>
          <span>Body</span>
          <textarea name="body" required maxLength={limits.bodyMax} rows={16} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} className={textareaClass} />
          <span className="block font-normal text-muted">
            Plain text with **bold**, [links](https://example.com), lists (- item) and blank lines between paragraphs. {body.length}/{limits.bodyMax}
          </span>
        </label>
        <section aria-label="Preview" className={`min-w-0 space-y-2 ${tab === "write" ? "max-lg:hidden" : ""}`}>
          <p className="text-sm font-medium">Preview</p>
          <div className="min-h-40 rounded-card border border-border bg-background p-4">
            {title.trim() && <h2 className="mb-3 font-display text-2xl font-semibold break-words">{title}</h2>}
            {body.trim() ? <KbBody body={body} /> : <p className="text-muted">Nothing to preview yet.</p>}
          </div>
        </section>
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {status === null ? (
          <>
            <button type="submit" name="intent" value="draft" disabled={pending} className={buttonSecondary}>
              {pending ? "Saving…" : "Save as draft"}
            </button>
            <button type="submit" name="intent" value="publish" disabled={pending} className={buttonPrimary}>
              {pending ? "Saving…" : "Publish"}
            </button>
          </>
        ) : (
          <>
            <button type="submit" name="intent" value="save" disabled={pending} className={buttonPrimary}>
              {pending ? "Saving…" : status === "published" ? "Save changes (stays published)" : "Save draft"}
            </button>
            {status === "draft" ? (
              <button type="submit" name="intent" value="publish" disabled={pending} className={buttonOutlineAccent}>
                Save and publish
              </button>
            ) : (
              <button type="submit" name="intent" value="unpublish" disabled={pending} className={buttonSecondary}>
                Unpublish (back to draft)
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
