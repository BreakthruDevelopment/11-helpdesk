import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createTicket, listTickets } from "@/lib/tickets";

export const dynamic = "force-dynamic";
// Creating a ticket waits up to 10 s for AI triage; an agent's queue load up to 5 s to finish pending triage.
export const maxDuration = 25;

/** GET /api/tickets: a customer's own tickets, or an agent's queue (?view=unassigned|mine|all&status=&limit=). Admins get 404. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await listTickets(user, params));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/tickets, body { subject, body }: a customer opens a ticket. 5 per hour, 20 per day, 50 open. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const created = await createTicket(user, await readJson(request, 32 * 1024));
    return Response.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
