import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listInbox } from "@/lib/mail/inbox";

export const dynamic = "force-dynamic";

/** GET /api/inbox: the caller's own notifications and unread count. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listInbox(user));
  } catch (err) {
    return errorResponse(err);
  }
}
