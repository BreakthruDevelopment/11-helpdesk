import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createArticle, listArticles } from "@/lib/kb";

export const dynamic = "force-dynamic";

/** GET /api/kb/articles?q=&status=draft|published: every article including drafts. Agents only. */
export async function GET(request: Request) {
  try {
    const agent = await requireRole("agent");
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await listArticles(agent, params));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/kb/articles, body { title, body, slug?, status? }: agents only. 60 writes per hour, 500 articles. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const agent = await requireRole("agent");
    const article = await createArticle(agent, await readJson(request, 32 * 1024));
    return Response.json({ article }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
