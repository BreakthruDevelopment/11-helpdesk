"use client";

import { useActionState, useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

/** Delete asks once more before it posts: a deleted article is gone and its public link becomes a 404. */
export function DeleteArticleForm({ action }: { action: (prev: FormState, formData: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={buttonDanger}>
        Delete article
      </button>
    );
  }
  return (
    <form action={formAction} className="space-y-3">
      <p className="font-medium">Delete this article for good? Its public page will stop working.</p>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={pending} className={buttonDanger}>
          {pending ? "Deleting…" : "Yes, delete"}
        </button>
        <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={buttonSecondary}>
          Keep it
        </button>
      </div>
    </form>
  );
}
