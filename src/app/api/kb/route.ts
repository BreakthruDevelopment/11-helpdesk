import { errorResponse } from "@/lib/http";
import { searchPublished } from "@/lib/kb";

export const dynamic = "force-dynamic";

/**
 * GET /api/kb?q=&limit=&offset=: public search over published articles (no sign-in). Drafts are never returned, to
 * anyone, agents included; they use /api/kb/articles. An empty `q` lists the newest published articles.
 */
export async function GET(request: Request) {
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await searchPublished(params));
  } catch (err) {
    return errorResponse(err);
  }
}
