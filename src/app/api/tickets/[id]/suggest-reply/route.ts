import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { getLatestSuggestion, suggestReply } from "@/lib/support-ai";

export const dynamic = "force-dynamic";
// The model call has its own timeout (AI_TIMEOUT_MS, at most 22 s).
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/tickets/:id/suggest-reply: the newest AI draft for this ticket, for agents. `{ suggestion: null }` if none. */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const agent = await requireRole("agent");
    return Response.json({ suggestion: await getLatestSuggestion(agent, (await params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/tickets/:id/suggest-reply: an agent asks for a draft reply (20 per hour, and the daily AI cap). The draft
 * is plain text for the agent's reply box. It is not sent and the ticket does not change. Customers and admins get 403.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    requireSameOrigin(request);
    const agent = await requireRole("agent");
    return Response.json({ suggestion: await suggestReply(agent, (await params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}
