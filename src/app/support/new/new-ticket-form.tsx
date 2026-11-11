"use client";

import { useActionState } from "react";
import { buttonPrimary, inputClass, labelClass, textareaClass } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

export function NewTicketForm({
  action,
  defaultSubject,
  subjectMax,
  bodyMax,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaultSubject: string;
  subjectMax: number;
  bodyMax: number;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="space-y-4">
      <label className={labelClass}>
        <span>Subject</span>
        <input
          name="subject"
          required
          maxLength={subjectMax}
          defaultValue={defaultSubject}
          disabled={pending}
          autoComplete="off"
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        <span>Describe the problem</span>
        <textarea name="body" required maxLength={bodyMax} rows={6} disabled={pending} className={textareaClass} />
      </label>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Opening…" : "Open ticket"}
      </button>
    </form>
  );
}
