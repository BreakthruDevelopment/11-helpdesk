import "server-only";
import { mailMessage } from "@/lib/db/schema";
import { type Mailer, mailMessageInput } from "./index";

/** The in-app outbox: one `mail_message` row per notification, written in the caller's transaction. */
export const outbox: Mailer = {
  async send(tx, msg) {
    const v = mailMessageInput.parse(msg); // lengths are enforced here and again by CHECK constraints
    await tx.insert(mailMessage).values(v);
  },
};

/** The configured mailer. `MAIL_PROVIDER` only knows `outbox` today (see index.ts for the seam). */
export function mailer(): Mailer {
  return outbox;
}
