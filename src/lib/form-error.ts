import "server-only";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { HttpError } from "@/lib/errors";

export type FormState = { error: string | null };

export const emptyFormState: FormState = { error: null };

/** A text field from a form. A file input is ignored so it can't skip the string schema. */
export function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * A message safe to show next to a form. Next.js uses thrown errors for redirects and not-found;
 * those are rethrown so the framework can finish them.
 */
export function formError(err: unknown): string {
  unstable_rethrow(err);
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError) {
    return err.message;
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    if (issue?.code === "too_big") return "That is too long. Shorten it and try again.";
    return issue?.message ?? "Check the form and try again.";
  }
  return "Something went wrong. Try again.";
}
