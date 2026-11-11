"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { formError, formField, type FormState } from "@/lib/form-error";
import { addMessage, createTicket, updateTicket } from "@/lib/tickets";

export async function openTicket(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const user = await requireRole("user");
    const created = await createTicket(user, {
      subject: formField(formData, "subject"),
      body: formField(formData, "body"),
    });
    revalidatePath("/support");
    redirect(`/support/${created.ticket.id}`);
  } catch (err) {
    return { error: formError(err) };
  }
}

export async function replyToTicket(ticketId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const user = await requireRole("user");
    await addMessage(user, ticketId, { body: formField(formData, "body") });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    redirect(`/support/${ticketId}`);
  } catch (err) {
    return { error: formError(err) };
  }
}

export async function resolveTicket(ticketId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  // The button posts no fields. Reading the body keeps the action signature and drops anything extra.
  void formData;
  try {
    const user = await requireRole("user");
    await updateTicket(user, ticketId, { action: "resolve" });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    redirect(`/support/${ticketId}`);
  } catch (err) {
    return { error: formError(err) };
  }
}
