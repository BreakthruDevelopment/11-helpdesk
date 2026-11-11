import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { getTriage, retriage } from "@/lib/support-ai";

export const dynamic = "force-dynamic";
// The model call has its own timeout (AI_TIMEOUT_MS, at most 22 s).
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/tickets/:id/triage: the ticket's AI triage card, for agents. `{ triage: null }` until triage has run. */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const agent = await requireRole("agent");
    return Response.json({ triage: await getTriage(agent, (await params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/tickets/:id/triage: an agent re-runs AI triage (3 per ticket, 30 per hour, and the daily AI cap).
 * Customers and admins get 403. Category and priority are applied only if no agent has set them.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    requireSameOrigin(request);
    const agent = await requireRole("agent");
    return Response.json(await retriage(agent, (await params).id));
  } catch (err) {
    return errorResponse(err);
  }
}
