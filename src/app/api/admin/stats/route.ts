import { adminStats } from "@/lib/admin-stats";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats (admin): counts only, never ticket contents. */
export async function GET() {
  try {
    const admin = await requireRole("admin");
    return Response.json(await adminStats(admin));
  } catch (err) {
    return errorResponse(err);
  }
}
