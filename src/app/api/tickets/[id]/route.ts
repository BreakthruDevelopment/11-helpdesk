import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getTicket, updateTicket } from "@/lib/tickets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/tickets/:id: the ticket and its thread. Customers: own ticket, public messages. Agents: everything. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await getTicket(user, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/tickets/:id. Customers: { action: "resolve" } only. Agents: { version, status?, priority?, category?,
 * assigneeId? }; a stale `version` is a 409.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ ticket: await updateTicket(user, id, await readJson(request, 32 * 1024)) });
  } catch (err) {
    return errorResponse(err);
  }
}
