import "server-only";
import { type SQL, and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { z } from "zod";
import { assertAgent } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Knowledge base data functions.
 *
 * Reads for the public (`searchPublished`, `getPublished`) take no actor on purpose: they are public by design, and
 * every query has `status = 'published'` in its WHERE, so a draft can't be returned to anyone through them, an agent
 * included. Everything that can see a draft or write takes the acting user and starts with `assertAgent(actor)`:
 * agents only, so customers and admins get a 403 (admin counts are tickets and roles, not content).
 */

const { kbArticle, user } = schema;

export const KB_LIMITS = {
  titleMax: 150,
  bodyMax: 10_000,
  slugMax: 100,
  queryMax: 200,
  maxArticles: 500,
  writesPerHour: 60,
  /** Characters of body shown under a result. */
  excerptChars: 200,
} as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const slugSchema = z
  .string()
  .max(KB_LIMITS.slugMax)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

// Postgres text can't hold NUL (22021); refuse it at the boundary instead of failing with a 500.
const noNul = (s: string) => !s.includes("\0");
const NUL_MESSAGE = "Contains an invalid character";

const titleSchema = z.string().trim().min(1, "Title is required").max(KB_LIMITS.titleMax).refine(noNul, NUL_MESSAGE);
const bodySchema = z.string().trim().min(1, "Body is required").max(KB_LIMITS.bodyMax).refine(noNul, NUL_MESSAGE);

/** `slug` is optional: when absent it is derived from the title and made unique. Once set it never changes. */
export const createArticleInput = z
  .object({ title: titleSchema, body: bodySchema, slug: slugSchema.optional(), status: z.enum(schema.KB_STATUSES).default("draft") })
  .strict();

export const updateArticleInput = z
  .object({ title: titleSchema.optional(), body: bodySchema.optional(), status: z.enum(schema.KB_STATUSES).optional() })
  .strict()
  .refine((v) => v.title !== undefined || v.body !== undefined || v.status !== undefined, { message: "Nothing to change" });

const queryText = z.string().trim().max(KB_LIMITS.queryMax).refine(noNul, NUL_MESSAGE);

export const publicSearchQuery = z.object({
  q: queryText.default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const agentListQuery = publicSearchQuery.extend({
  status: z.enum(schema.KB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** All the public ever sees of an article: no author, no status, no timestamps beyond the last edit. */
export type PublicArticle = { id: string; slug: string; title: string; body: string; updatedAt: Date };
export type PublicResult = { id: string; slug: string; title: string; excerpt: string; updatedAt: Date };
export type AgentArticle = Omit<typeof kbArticle.$inferSelect, "search"> & { authorName: string | null };
type Page = { hasMore: boolean; nextOffset: number | null };

const publicColumns = { id: kbArticle.id, slug: kbArticle.slug, title: kbArticle.title, body: kbArticle.body, updatedAt: kbArticle.updatedAt };
const agentColumns = {
  id: kbArticle.id,
  slug: kbArticle.slug,
  title: kbArticle.title,
  body: kbArticle.body,
  status: kbArticle.status,
  authorId: kbArticle.authorId,
  authorName: user.name,
  createdAt: kbArticle.createdAt,
  updatedAt: kbArticle.updatedAt,
};

const toExcerpt = (body: string) => (body.length > KB_LIMITS.excerptChars ? `${body.slice(0, KB_LIMITS.excerptChars - 1).trimEnd()}…` : body);

function paged<T>(rows: T[], limit: number, offset: number): { rows: T[] } & Page {
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore, nextOffset: hasMore ? offset + limit : null };
}

/** A malformed id is a missing article: probing ids must look the same as a miss. */
function articleId(id: string): string {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type SearchParts = { match: SQL; order: SQL[] };

function partsFor(tsq: SQL): SearchParts {
  return {
    match: sql`${kbArticle.search} @@ ${tsq}`,
    order: [
      sql`(to_tsvector('english', ${kbArticle.title}) @@ ${tsq}) desc`,
      sql`ts_rank(${kbArticle.search}, ${tsq}) desc`,
      desc(kbArticle.updatedAt),
      desc(kbArticle.id),
    ],
  };
}

/**
 * The text-search predicate and its order for a trimmed, non-empty query.
 * `websearch_to_tsquery` takes what people type (quotes, `or`, `-word`) and never raises a syntax error, but it
 * requires every word to match, so a natural question ("I was charged twice") finds nothing when one word is missing
 * from every article. When the strict query matches nothing, search again with any of the words (the stemmed
 * lexemes OR-ed together), so a close article still comes back. Ordering either way: a title match before a body-only
 * match, then `ts_rank` (which also weights the title above the body), then newest edit, then id so pages are stable.
 * The mode is chosen once per query, before paging, so every page of one search uses the same rule.
 */
async function searchParts(q: string, scope: SQL | undefined): Promise<SearchParts> {
  const strict = partsFor(sql`websearch_to_tsquery('english', ${q})`);
  const [hit] = await db().select({ id: kbArticle.id }).from(kbArticle).where(and(scope, strict.match)).limit(1);
  if (hit) return strict;
  // Lexemes come out of to_tsvector already stemmed; the regex keeps only plain ones so to_tsquery can't choke.
  return partsFor(sql`(
    select to_tsquery('simple', string_agg(lexeme, ' | '))
    from unnest(tsvector_to_array(to_tsvector('english', ${q}))) as lexeme
    where lexeme ~ '^[a-z0-9]+$'
  )`);
}

/**
 * Public search over published articles. An empty query lists them, newest edit first. Never returns a draft.
 * Also the source for "matching articles as you type a subject" (limit 5) and for AI retrieval (issue 11.3).
 */
export async function searchPublished(input: unknown = {}): Promise<{ articles: PublicResult[] } & Page> {
  const q = publicSearchQuery.parse(input);
  const published = eq(kbArticle.status, "published");
  const parts = q.q ? await searchParts(q.q, published) : null;
  const rows = await db()
    .select(publicColumns)
    .from(kbArticle)
    .where(parts ? and(published, parts.match) : published)
    .orderBy(...(parts ? parts.order : [desc(kbArticle.updatedAt), desc(kbArticle.id)]))
    .limit(q.limit + 1)
    .offset(q.offset);
  const p = paged(rows, q.limit, q.offset);
  return {
    articles: p.rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, excerpt: toExcerpt(r.body), updatedAt: r.updatedAt })),
    hasMore: p.hasMore,
    nextOffset: p.nextOffset,
  };
}

/** One published article by slug, for `/kb/[slug]`. A draft or an unknown slug is a 404. Cached per request so `generateMetadata` and the page share one query. */
export const getPublished = cache(async (slug: string): Promise<PublicArticle> => {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) throw new NotFoundError();
  const [row] = await db()
    .select(publicColumns)
    .from(kbArticle)
    .where(and(eq(kbArticle.slug, parsed.data), eq(kbArticle.status, "published")));
  if (!row) throw new NotFoundError();
  return row;
});

// ---------------------------------------------------------------------------
// AI grounding (issue 11.3)
// ---------------------------------------------------------------------------

/** A published article as the AI features see it. Never a draft, never an author. */
export type GroundingArticle = { id: string; slug: string; title: string; body: string };

/**
 * The best published matches for free text (a subject plus a customer's message), same ranking as `searchPublished`.
 * Takes no actor, like the public search: it can only ever return published rows. The caller has already decided
 * the text may be searched (the text is cut to the query limit here).
 */
export async function retrieveForAi(text: string, limit: number): Promise<GroundingArticle[]> {
  const q = text.replace(/\0/g, "").replace(/\s+/g, " ").trim().slice(0, KB_LIMITS.queryMax).trim();
  if (!q || limit < 1) return [];
  const published = eq(kbArticle.status, "published");
  const parts = await searchParts(q, published);
  return db()
    .select({ id: kbArticle.id, slug: kbArticle.slug, title: kbArticle.title, body: kbArticle.body })
    .from(kbArticle)
    .where(and(published, parts.match))
    .orderBy(...parts.order)
    .limit(Math.min(limit, 10));
}

/** Of these ids, the ones that are published articles right now (a model's, or a stored, suggestion is re-checked here). */
export async function publishedByIds(ids: readonly string[]): Promise<GroundingArticle[]> {
  const valid = ids.filter((id) => z.string().uuid().safeParse(id).success);
  if (valid.length === 0) return [];
  const rows = await db()
    .select({ id: kbArticle.id, slug: kbArticle.slug, title: kbArticle.title, body: kbArticle.body })
    .from(kbArticle)
    .where(and(eq(kbArticle.status, "published"), inArray(kbArticle.id, valid)));
  // Keep the caller's order.
  return valid.map((id) => rows.find((r) => r.id === id)).filter((r): r is GroundingArticle => r !== undefined);
}

// ---------------------------------------------------------------------------
// Agent reads
// ---------------------------------------------------------------------------

/** Agents: every article, drafts included, optionally filtered by `status` and searched with `q`. */
export async function listArticles(actor: Actor, input: unknown = {}): Promise<{ articles: AgentArticle[] } & Page> {
  assertAgent(actor);
  const q = agentListQuery.parse(input);
  const statusScope = q.status ? eq(kbArticle.status, q.status) : undefined;
  const parts = q.q ? await searchParts(q.q, statusScope) : null;
  const rows = await db()
    .select(agentColumns)
    .from(kbArticle)
    .leftJoin(user, eq(user.id, kbArticle.authorId))
    .where(and(statusScope, parts?.match))
    .orderBy(...(parts ? parts.order : [desc(kbArticle.updatedAt), desc(kbArticle.id)]))
    .limit(q.limit + 1)
    .offset(q.offset);
  const p = paged(rows, q.limit, q.offset);
  return { articles: p.rows, hasMore: p.hasMore, nextOffset: p.nextOffset };
}

export async function getArticle(actor: Actor, id: string): Promise<AgentArticle> {
  assertAgent(actor);
  const [row] = await db().select(agentColumns).from(kbArticle).leftJoin(user, eq(user.id, kbArticle.authorId)).where(eq(kbArticle.id, articleId(id)));
  if (!row) throw new NotFoundError();
  return row;
}

// ---------------------------------------------------------------------------
// Agent writes
// ---------------------------------------------------------------------------

/** "How to reset your password!" becomes `how-to-reset-your-password`; nothing usable becomes `article`. */
export function slugify(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KB_LIMITS.slugMax - 6)
    .replace(/-+$/g, "");
  return base || "article";
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [hit] = await tx.select({ id: kbArticle.id }).from(kbArticle).where(eq(kbArticle.slug, candidate));
    if (!hit) return candidate;
  }
  throw new ConflictError("Couldn't pick a unique address for this article. Give it a different title.");
}

async function chargeWrite(tx: Tx, actor: Actor) {
  await consumeRate(tx, actor.id, "kb_write", KB_LIMITS.writesPerHour, "You can make 60 knowledge-base changes per hour. Try again later.");
}

export async function createArticle(actor: Actor, input: unknown): Promise<AgentArticle> {
  assertAgent(actor);
  const data = createArticleInput.parse(input);

  const created = await db().transaction(async (tx) => {
    await chargeWrite(tx, actor);
    // One lock for the count and the slug, so two creates can't both take the 500th slot or the same address.
    await advisoryLock(tx, "kb:create");
    const [{ n }] = await tx.select({ n: count() }).from(kbArticle);
    if (n >= KB_LIMITS.maxArticles) throw new ConflictError("The knowledge base is full (500 articles). Delete one first.");
    let slug: string;
    if (data.slug) {
      const [taken] = await tx.select({ id: kbArticle.id }).from(kbArticle).where(eq(kbArticle.slug, data.slug));
      if (taken) throw new ConflictError("An article with that address already exists.");
      slug = data.slug;
    } else {
      slug = await uniqueSlug(tx, slugify(data.title));
    }
    const [row] = await tx.insert(kbArticle).values({ slug, title: data.title, body: data.body, status: data.status, authorId: actor.id }).returning({ id: kbArticle.id });
    return row;
  });

  log.info("kb.article_created", { articleId: created.id, by: actor.id, status: data.status });
  return getArticle(actor, created.id);
}

/** Edit title, body or status (publish and unpublish). The address (slug) stays, so published links don't break. */
export async function updateArticle(actor: Actor, id: string, input: unknown): Promise<AgentArticle> {
  assertAgent(actor);
  const aid = articleId(id);
  const data = updateArticleInput.parse(input);

  await db().transaction(async (tx) => {
    await chargeWrite(tx, actor);
    const updated = await tx
      .update(kbArticle)
      .set({ ...data, updatedAt: sql`now()` })
      .where(eq(kbArticle.id, aid))
      .returning({ id: kbArticle.id });
    if (updated.length === 0) throw new NotFoundError();
  });

  log.info("kb.article_updated", { articleId: aid, by: actor.id, status: data.status });
  return getArticle(actor, aid);
}

export async function deleteArticle(actor: Actor, id: string): Promise<void> {
  assertAgent(actor);
  const aid = articleId(id);
  await db().transaction(async (tx) => {
    await chargeWrite(tx, actor);
    const deleted = await tx.delete(kbArticle).where(eq(kbArticle.id, aid)).returning({ id: kbArticle.id });
    if (deleted.length === 0) throw new NotFoundError();
  });
  log.info("kb.article_deleted", { articleId: aid, by: actor.id });
}
