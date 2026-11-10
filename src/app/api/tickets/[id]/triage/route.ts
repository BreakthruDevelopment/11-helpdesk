import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/tickets/:id/triage: agents re-run AI triage. The access wall is in place (customers get 403 and admins
 * 403); the triage itself arrives with issue 11.3, so an agent gets 501 until then.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireRole("agent");
    return Response.json({ error: "Triage is not available yet" }, { status: 501 });
  } catch (err) {
    return errorResponse(err);
  }
}
