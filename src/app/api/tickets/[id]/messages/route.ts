import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { addMessage } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/**
 * POST /api/tickets/:id/messages, body { body, visibility?: "public" | "internal", aiAssisted? }. Customers write public
 * messages only (internal is a 403); agents write replies or internal notes. 60 per user per hour.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    const message = await addMessage(user, id, await readJson(request, 32 * 1024));
    return Response.json({ message }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
