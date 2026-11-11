"use client";

import { useActionState } from "react";
import { buttonPrimary, labelClass, textareaClass } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

export function ReplyForm({
  action,
  bodyMax,
  reopen,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  bodyMax: number;
  reopen: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="space-y-4">
      <label className={labelClass}>
        <span>Reply</span>
        <textarea name="body" required maxLength={bodyMax} rows={5} disabled={pending} className={textareaClass} />
      </label>
      {reopen && <p className="text-sm text-muted">A reply reopens this ticket.</p>}
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Sending…" : "Send reply"}
      </button>
    </form>
  );
}
