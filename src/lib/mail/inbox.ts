import "server-only";
import { and, count, desc, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { mailScope } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";

const { mailMessage } = schema;

export type InboxMessage = {
  id: string;
  kind: (typeof mailMessage.kind.enumValues)[number];
  ticketId: string;
  subject: string;
  snippet: string;
  readAt: Date | null;
  createdAt: Date;
};

/**
 * A signed-in user's own notifications, newest first, plus the unread count for the header badge. Every role has an
 * inbox, admins included (they receive none today); nobody can read another recipient's rows.
 */
export async function listInbox(actor: Actor): Promise<{ messages: InboxMessage[]; unread: number }> {
  const messages = await db()
    .select({
      id: mailMessage.id,
      kind: mailMessage.kind,
      ticketId: mailMessage.ticketId,
      subject: mailMessage.subject,
      snippet: mailMessage.snippet,
      readAt: mailMessage.readAt,
      createdAt: mailMessage.createdAt,
    })
    .from(mailMessage)
    .where(mailScope(actor))
    .orderBy(desc(mailMessage.createdAt))
    .limit(100);
  return { messages, unread: await unreadCount(actor) };
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(mailMessage)
    .where(and(mailScope(actor), isNull(mailMessage.readAt)));
  return row.n;
}

export const markReadInput = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict(),
]);

/** Mark some or all of the caller's own notifications read. Ids that belong to someone else simply match nothing. */
export async function markInboxRead(actor: Actor, input: unknown): Promise<{ marked: number; unread: number }> {
  const v = markReadInput.parse(input);
  const which = "all" in v ? undefined : inArray(mailMessage.id, v.ids);
  const rows = await db()
    .update(mailMessage)
    .set({ readAt: new Date() })
    .where(and(mailScope(actor), isNull(mailMessage.readAt), which))
    .returning({ id: mailMessage.id });
  return { marked: rows.length, unread: await unreadCount(actor) };
}

