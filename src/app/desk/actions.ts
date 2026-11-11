"use server";

import { revalidatePath } from "next/cache";
import { AiError } from "@/lib/ai/types";
import { requireRole } from "@/lib/auth/session";
import { formError, formField } from "@/lib/form-error";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";
import { retriage, suggestReply, type ReplySuggestionView } from "@/lib/support-ai";
import { addMessage, updateTicket } from "@/lib/tickets";

/** A form result. `done` counts successes, so the client can clear its box after each send. */
export type DeskFormState = { error: string | null; done: number };

function refresh(ticketId: string) {
  revalidatePath(`/desk/${ticketId}`);
  revalidatePath("/desk");
}

function aiMessage(err: unknown): string {
  if (err instanceof AiError) {
    if (err.kind === "quota") return "The AI limit for today is reached. Write the reply yourself.";
    log.warn("desk.ai_failed", safeErrorFields(err));
    return "The AI didn't answer this time. Try again, or write the reply yourself.";
  }
  return formError(err);
}

/**
 * Send a public reply or save an internal note. `aiAssisted` is only honoured on a public reply the agent built from
 * an AI draft; a note is never marked AI-assisted. Every action checks the agent role itself.
 */
export async function sendMessage(ticketId: string, prev: DeskFormState, formData: FormData): Promise<DeskFormState> {
  try {
    const agent = await requireRole("agent");
    const visibility = formField(formData, "visibility") === "internal" ? "internal" : "public";
    const aiAssisted = visibility === "public" && formField(formData, "aiAssisted") === "true";
    await addMessage(agent, ticketId, { body: formField(formData, "body"), visibility, aiAssisted });
    refresh(ticketId);
    return { error: null, done: prev.done + 1 };
  } catch (err) {
    return { error: formError(err), done: prev.done };
  }
}

const FIELDS = ["status", "priority", "category", "assignee"] as const;

/**
 * Change one property with the version the agent read; a stale version comes back as "This ticket changed…".
 * Assignee values: "me" (the signed-in agent), "none" (unassign) or "keep".
 */
export async function updateProperty(ticketId: string, prev: DeskFormState, formData: FormData): Promise<DeskFormState> {
  try {
    const agent = await requireRole("agent");
    const field = formField(formData, "field");
    if (!(FIELDS as readonly string[]).includes(field)) return { error: "Pick something to change.", done: prev.done };
    const value = formField(formData, "value");
    const version = Number(formField(formData, "version"));
    let patch: Record<string, unknown>;
    if (field === "assignee") {
      if (value !== "me" && value !== "none") return { error: "Pick who should own this ticket.", done: prev.done };
      patch = { assigneeId: value === "me" ? agent.id : null };
    } else {
      patch = { [field]: value };
    }
    await updateTicket(agent, ticketId, { version, ...patch });
    refresh(ticketId);
    return { error: null, done: prev.done + 1 };
  } catch (err) {
    return { error: formError(err), done: prev.done };
  }
}

/** Ask for a reply draft. Nothing is sent and the ticket doesn't change: the draft goes back to this agent only. */
export async function requestSuggestion(ticketId: string): Promise<{ suggestion: ReplySuggestionView | null; error: string | null }> {
  try {
    const agent = await requireRole("agent");
    return { suggestion: await suggestReply(agent, ticketId), error: null };
  } catch (err) {
    return { suggestion: null, error: aiMessage(err) };
  }
}

/** Re-run triage (3 per ticket). The data layer only applies it where no agent has set category or priority. */
export async function requestRetriage(ticketId: string): Promise<{ error: string | null }> {
  try {
    const agent = await requireRole("agent");
    await retriage(agent, ticketId);
    refresh(ticketId);
    return { error: null };
  } catch (err) {
    return { error: aiMessage(err) };
  }
}
