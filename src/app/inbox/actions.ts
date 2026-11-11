"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { formError, formField, type FormState } from "@/lib/form-error";
import { markInboxRead } from "@/lib/mail/inbox";

export async function markRead(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const user = await requireUser();
    const all = formField(formData, "all") === "true";
    const id = formField(formData, "id");
    if (!all && !id) return { error: "Choose a message to mark as read." };
    await markInboxRead(user, all ? { all: true } : { ids: [id] });
    // The unread badge lives in the root layout, so refresh that as well as this page.
    revalidatePath("/", "layout");
    return { error: null };
  } catch (err) {
    return { error: formError(err) };
  }
}
