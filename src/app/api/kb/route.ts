import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";
import { searchPublished } from "@/lib/kb";

export const dynamic = "force-dynamic";

/**
 * GET /api/kb?q=&limit=&offset=: public search over published articles (no sign-in). Drafts are never returned, to
 * anyone, agents included; they use /api/kb/articles. An empty `q` lists the newest published articles.
 * Limited to 60 requests per minute per IP (429 with Retry-After), since there is no sign-in to count against.
 */
export async function GET(request: Request) {
  try {
    if (!allowPublicRequest(clientIp(request))) {
      return Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    }
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await searchPublished(params));
  } catch (err) {
    return errorResponse(err);
  }
}
