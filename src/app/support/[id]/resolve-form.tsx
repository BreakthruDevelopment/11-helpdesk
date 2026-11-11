"use client";

import { useActionState } from "react";
import { buttonSecondary } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

export function ResolveForm({ action }: { action: (prev: FormState, formData: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm text-muted">Closes the ticket. You can reply within 7 days to reopen it.</p>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${buttonSecondary} w-full sm:w-auto`}>
        {pending ? "Closing…" : "Mark resolved"}
      </button>
    </form>
  );
}
