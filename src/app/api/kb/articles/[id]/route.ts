import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { deleteArticle, getArticle, updateArticle } from "@/lib/kb";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/kb/articles/:id: one article, draft or published. Agents only. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const agent = await requireRole("agent");
    const { id } = await ctx.params;
    return Response.json({ article: await getArticle(agent, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/kb/articles/:id, body { title?, body?, status? }: edit, publish or unpublish. Agents only. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const agent = await requireRole("agent");
    const { id } = await ctx.params;
    return Response.json({ article: await updateArticle(agent, id, await readJson(request, 32 * 1024)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/kb/articles/:id: agents only. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const agent = await requireRole("agent");
    const { id } = await ctx.params;
    await deleteArticle(agent, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
