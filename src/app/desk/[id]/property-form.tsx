"use client";

import { useActionState, type ReactNode } from "react";
import { buttonSecondary, inputClass } from "@/components/ui/styles";
import type { DeskFormState } from "../actions";

type Option = { value: string; label: string };

/** One property with its own Save, so a stale version only fails the change the agent just made. */
export function PropertyForm({
  action,
  field,
  label,
  version,
  value,
  options,
}: {
  action: (prev: DeskFormState, formData: FormData) => Promise<DeskFormState>;
  field: "status" | "priority" | "category";
  label: string;
  version: number;
  value: string;
  options: Option[];
}) {
  const [state, formAction, pending] = useActionState(action, { error: null, done: 0 });
  const id = `prop-${field}`;
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="version" value={version} />
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <select id={id} name="value" defaultValue={value} key={`${version}-${value}`} disabled={pending} className={`${inputClass} min-w-0 flex-1`}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonSecondary}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** A one-click change (Assign to me, Unassign, Apply a triage suggestion): fixed field and value, the version read. */
export function QuickChange({
  action,
  field,
  value,
  version,
  children,
  className = buttonSecondary,
}: {
  action: (prev: DeskFormState, formData: FormData) => Promise<DeskFormState>;
  field: "status" | "priority" | "category" | "assignee";
  value: string;
  version: number;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null, done: 0 });
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="value" value={value} />
      <input type="hidden" name="version" value={version} />
      <button type="submit" disabled={pending} className={`${className} w-full sm:w-auto`}>
        {pending ? "Saving…" : children}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
