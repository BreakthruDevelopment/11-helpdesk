import { z } from "zod";
import { MAIL_KINDS } from "@/lib/db/schema";
import type { Tx } from "@/lib/usage";

/**
 * Notifications leave the app through a `Mailer`. Today there is one implementation, the in-app outbox
 * (`./outbox.ts`): `send` inserts a `mail_message` row in the SAME transaction as the event that caused it, and the
 * recipient reads it at /inbox. No email is sent anywhere.
 *
 * The seam: `MAIL_PROVIDER=smtp|resend` would add an implementation that does the outbox insert and then enqueues a
 * `send-mail` job keyed by the message id (idempotent; inline mode on Cloud Run). Nothing else changes, because every
 * caller goes through `mailer().send(tx, msg)` (`mailer()` is in `./outbox.ts`, the one place that picks the provider).
 */
export type MailKind = (typeof MAIL_KINDS)[number];

export const SUBJECT_MAX = 150;
export const SNIPPET_MAX = 200;

export const mailMessageInput = z.object({
  recipientId: z.string().min(1),
  kind: z.enum(MAIL_KINDS),
  ticketId: z.string().uuid(),
  subject: z.string().min(1).max(SUBJECT_MAX),
  snippet: z.string().max(SNIPPET_MAX),
});
export type OutgoingMail = z.infer<typeof mailMessageInput>;

export interface Mailer {
  /** Record the message inside the caller's transaction, so a rolled-back event leaves no notification. */
  send(tx: Tx, msg: OutgoingMail): Promise<void>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export const subjectFor = (ticketSubject: string): string => clip(ticketSubject, SUBJECT_MAX) || "Support ticket";

/**
 * The only way a snippet is built from a ticket message. An internal note throws, so a note can't reach a
 * notification even if a caller passes the wrong row: this is the structural half of "notes never leak" (the other
 * half is that no caller passes anything but the message it just wrote as public).
 */
export function publicSnippet(message: { visibility: string; body: string }): string {
  if (message.visibility !== "public") throw new Error("Internal notes cannot be used in notifications.");
  return clip(message.body, SNIPPET_MAX);
}
