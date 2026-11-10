import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { markInboxRead } from "@/lib/mail/inbox";

export const dynamic = "force-dynamic";

/** POST /api/inbox/read, body { all: true } or { ids: uuid[] }: mark the caller's own notifications read. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json(await markInboxRead(user, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
