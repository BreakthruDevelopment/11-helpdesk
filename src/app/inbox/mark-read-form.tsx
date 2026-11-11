"use client";

import { useActionState } from "react";
import { buttonSecondary } from "@/components/ui/styles";
import type { FormState } from "@/lib/form-error";

export function MarkReadForm({
  action,
  label,
  pendingLabel,
  id,
  all = false,
  accessibleName,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  pendingLabel: string;
  id?: string;
  all?: boolean;
  accessibleName?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      {all ? <input type="hidden" name="all" value="true" /> : <input type="hidden" name="id" value={id ?? ""} />}
      <button type="submit" disabled={pending} aria-label={accessibleName} className={buttonSecondary}>
        {pending ? pendingLabel : label}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
