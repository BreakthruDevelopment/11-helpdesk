import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/demo (admin): replace the demo users' tickets with the sample workspace. Bodyless: callers can't
 * choose CLI credentials or elevate a demo user. 1 per minute and 5 per UTC day for the whole app. Answers counts only.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireRole("admin");
    return Response.json(await loadDemoWorkspace(actor, { mode: "admin" }, new Date(), { reserve: true }));
  } catch (err) {
    return errorResponse(err);
  }
}
