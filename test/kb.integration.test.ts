/**
 * Knowledge base against a real Postgres (TEST_DATABASE_URL), through the real route handlers (only the session lookup
 * is replaced). Access rules per row: the public reads published articles only; agents read and write everything;
 * customers and admins can't write or see drafts. Search: title matches rank first and a draft never comes back publicly.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Role = "user" | "agent" | "admin";
type Who = { id: string; name: string; email: string; role: Role };

const current = vi.hoisted(() => ({ actor: null as Who | null }));
vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  const requireUser = async () => {
    if (!current.actor) throw new UnauthorizedError();
    return current.actor;
  };
  return {
    requireUser,
    requireRole: async (role: Role) => {
      const user = await requireUser();
      if (user.role !== role) throw new ForbiddenError();
      return user;
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const mk = (id: string, role: Role): Who => ({ id, name: `${id} name`, email: `${id}@test.local`, role });
const ada = mk("kbt-ada", "user");
const gina = mk("kbt-gina", "agent");
const hank = mk("kbt-hank", "agent");
const root = mk("kbt-root", "admin");

describe.skipIf(!url)("knowledge base (Postgres)", () => {
  let sql: postgres.Sql;
  let PUB: typeof import("@/app/api/kb/route");
  let ART: typeof import("@/app/api/kb/articles/route");
  let ONE: typeof import("@/app/api/kb/articles/[id]/route");
  let kb: typeof import("@/lib/kb");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  const as = (who: Who | null) => void (current.actor = who);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  function req(path: string, method = "GET", body?: unknown, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  }
  async function json(res: Response) {
    return { status: res.status, text: await res.clone().text(), body: (await res.json().catch(() => null)) as Json };
  }
  const search = async (q: string, who: Who | null = null) => {
    as(who);
    const r = await json(await PUB.GET(req(`/api/kb?q=${encodeURIComponent(q)}`)));
    expect(r.status).toBe(200);
    return r.body.articles as { slug: string; title: string }[];
  };
  async function create(who: Who, body: Record<string, unknown>) {
    as(who);
    return json(await ART.POST(req("/api/kb/articles", "POST", body)));
  }
  const slugs = (xs: { slug: string }[]) => xs.map((x) => x.slug);
  const clean = async () => {
    await sql`delete from kb_article where slug like 'kbt-%' or author_id like 'kbt-%'`;
    await sql`delete from rate_event where user_id like 'kbt-%'`;
    await sql`delete from "user" where id like 'kbt-%'`;
  };

  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: url, BETTER_AUTH_SECRET: "kb-integration-secret-0123456789-abcdefgh", APP_URL: ORIGIN, LOG_LEVEL: "error", NODE_ENV: "test" });
    (await import("@/lib/env")).resetEnvCache();
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await clean();
    for (const u of [ada, gina, hank, root]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role})`;
    PUB = await import("@/app/api/kb/route");
    ART = await import("@/app/api/kb/articles/route");
    ONE = await import("@/app/api/kb/articles/[id]/route");
    kb = await import("@/lib/kb");
  });
  afterAll(async () => {
    await clean();
    await sql.end();
  });
  beforeEach(async () => {
    as(null);
    await sql`delete from kb_article where slug like 'kbt-%' or author_id like 'kbt-%'`;
    await sql`delete from rate_event where user_id like 'kbt-%'`;
  });

  describe("the seeded articles", () => {
    it("15 are seeded (13 published, 2 drafts) and the public sees only the published ones", async () => {
      const seeded = [...readFileSync("drizzle/0007_kb_seed_articles.sql", "utf8").matchAll(/VALUES \('([a-z0-9-]+)'/g)].map((m) => m[1]);
      expect(seeded).toHaveLength(15);
      const rows = await sql`select slug, status from kb_article where slug = any(${seeded})`;
      expect(rows).toHaveLength(15);
      expect(rows.filter((r) => r.status === "published")).toHaveLength(13);
      const listed = slugs(await search(""));
      expect(listed).toHaveLength(10);
      const all = ((await json(await PUB.GET(req("/api/kb?limit=20")))).body.articles as { slug: string }[]).map((a) => a.slug);
      for (const r of rows) expect(all.includes(r.slug)).toBe(r.status === "published");
    });

    it("finds the obvious article for a real question", async () => {
      expect((await search("I was charged twice"))[0]?.slug).toBe("billing-duplicate-charges");
      expect((await search("how do I reset my password"))[0]?.slug).toBe("reset-your-password");
      expect(slugs(await search("export csv"))).toContain("export-your-data");
    });
  });

  describe("public search", () => {
    it("needs no sign-in and returns published articles only, never a draft, for anyone including agents", async () => {
      await create(gina, { title: "kbt zebracorn published", body: "zebracorn steps", slug: "kbt-pub", status: "published" });
      await create(gina, { title: "kbt zebracorn secret draft", body: "zebracorn internal plan", slug: "kbt-draft", status: "draft" });
      for (const who of [null, ada, gina, root]) {
        const found = slugs(await search("zebracorn", who));
        expect(found, who?.id ?? "anonymous").toEqual(["kbt-pub"]);
      }
      // ...nor by browsing, nor by slug through the data function.
      expect(slugs(await search(""))).not.toContain("kbt-draft");
      await expect(kb.getPublished("kbt-draft")).rejects.toMatchObject({ status: 404 });
      expect((await kb.getPublished("kbt-pub")).title).toBe("kbt zebracorn published");
    });

    it("results carry only public fields: no author, status or draft markers", async () => {
      await create(gina, { title: "kbt quokka", body: "quokka guide", slug: "kbt-fields", status: "published" });
      as(null);
      const r = await json(await PUB.GET(req("/api/kb?q=quokka")));
      expect(Object.keys(r.body.articles[0]).sort()).toEqual(["excerpt", "id", "slug", "title", "updatedAt"]);
      expect(r.text).not.toContain(gina.id);
    });

    it("ranks a title match ahead of a body-only match, even when the body repeats the word", async () => {
      await create(gina, { title: "kbt other topic entirely", body: Array(40).fill("quokkaflux").join(" ") + " plus more words", slug: "kbt-body-heavy", status: "published" });
      await create(gina, { title: "About quokkaflux", body: "A short article.", slug: "kbt-title-hit", status: "published" });
      await create(gina, { title: "kbt another", body: "mentions quokkaflux once", slug: "kbt-body-once", status: "published" });
      const found = slugs(await search("quokkaflux"));
      expect(found[0]).toBe("kbt-title-hit");
      expect(found).toHaveLength(3);
    });

    it("understands web-style queries and never errors on odd input", async () => {
      await create(gina, { title: "kbt narwhal setup", body: "install the narwhal agent", slug: "kbt-nar1", status: "published" });
      await create(gina, { title: "kbt narwhal removal", body: "remove the narwhal agent", slug: "kbt-nar2", status: "published" });
      expect(slugs(await search("narwhal -removal"))).toEqual(["kbt-nar1"]);
      expect(slugs(await search('"narwhal setup"'))).toEqual(["kbt-nar1"]);
      expect(slugs(await search("narwhal or nothingmatches")).sort()).toEqual(["kbt-nar1", "kbt-nar2"]);
      for (const odd of ['"', "(((", "a & | !", "'; drop table kb_article; --", "the and of", "%00", "日本語"]) {
        as(null);
        expect((await PUB.GET(req(`/api/kb?q=${encodeURIComponent(odd)}`))).status, odd).toBe(200);
      }
      expect((await sql`select count(*)::int as n from kb_article`)[0].n).toBeGreaterThanOrEqual(15);
    });

    it("a natural question still finds the close article when one word matches nothing, and still never a draft", async () => {
      await create(gina, { title: "kbt gryphon setup", body: "install the gryphon", slug: "kbt-gry-pub", status: "published" });
      await create(gina, { title: "kbt gryphon secret", body: "gryphon internal", slug: "kbt-gry-draft", status: "draft" });
      expect(slugs(await search("gryphon unrelatedwordzz"))).toEqual(["kbt-gry-pub"]);
      const loose = slugs(await search("how do I set up the gryphon, please"));
      expect(loose[0]).toBe("kbt-gry-pub"); // the title match leads, whatever else shares a word
      expect(loose).not.toContain("kbt-gry-draft");
      expect(await search("unrelatedwordzz alsonothing")).toEqual([]);
      expect(await search("the and of")).toEqual([]);
    });

    it("validates its parameters: a query over 200 characters and a silly limit are 400", async () => {
      as(null);
      expect((await PUB.GET(req(`/api/kb?q=${"x".repeat(201)}`))).status).toBe(400);
      expect((await PUB.GET(req("/api/kb?limit=1000"))).status).toBe(400);
      expect((await PUB.GET(req("/api/kb?limit=0"))).status).toBe(400);
      // NUL can't be stored or searched in Postgres text; it is a 400, never a 500.
      expect((await PUB.GET(req("/api/kb?q=%00"))).status).toBe(400);
      expect((await PUB.GET(req("/api/kb?q=a%00b"))).status).toBe(400);
    });

    it("pages with limit and offset", async () => {
      for (let i = 0; i < 4; i++) await create(gina, { title: `kbt pagetoken ${i}`, body: "pagetoken", slug: `kbt-page-${i}`, status: "published" });
      as(null);
      const p1 = (await json(await PUB.GET(req("/api/kb?q=pagetoken&limit=3")))).body;
      expect(p1.articles).toHaveLength(3);
      expect(p1.hasMore).toBe(true);
      const p2 = (await json(await PUB.GET(req(`/api/kb?q=pagetoken&limit=3&offset=${p1.nextOffset}`)))).body;
      expect(p2.articles).toHaveLength(1);
      expect(p2.hasMore).toBe(false);
      expect(new Set([...p1.articles, ...p2.articles].map((a: { id: string }) => a.id)).size).toBe(4);
    });
  });

  describe("agent-only writes and draft access", () => {
    const draft = { title: "kbt walrus draft", body: "walrus plans", slug: "kbt-walrus", status: "draft" };

    it("an agent creates, edits, publishes, unpublishes and deletes", async () => {
      const made = await create(gina, draft);
      expect(made.status).toBe(201);
      expect(made.body.article).toMatchObject({ slug: "kbt-walrus", status: "draft", authorId: gina.id, authorName: gina.name });
      expect(made.body.article.search).toBeUndefined();
      const id = made.body.article.id as string;

      expect(slugs(await search("walrus"))).toEqual([]);
      as(hank); // any agent may edit any article
      const published = await json(await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { status: "published", body: "walrus steps" }), ctx(id)));
      expect(published.status).toBe(200);
      expect(published.body.article).toMatchObject({ status: "published", body: "walrus steps", authorId: gina.id });
      expect(slugs(await search("walrus"))).toEqual(["kbt-walrus"]);

      as(gina);
      await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { status: "draft" }), ctx(id));
      expect(slugs(await search("walrus"))).toEqual([]);

      as(gina);
      const del = await ONE.DELETE(req(`/api/kb/articles/${id}`, "DELETE"), ctx(id));
      expect(del.status).toBe(204);
      expect((await json(await ONE.GET(req(`/api/kb/articles/${id}`), ctx(id)))).status).toBe(404);
    });

    it("agents list and read drafts through the agent routes", async () => {
      const id = (await create(gina, draft)).body.article.id as string;
      as(hank);
      const list = await json(await ART.GET(req("/api/kb/articles?status=draft&q=walrus")));
      expect(slugs(list.body.articles)).toEqual(["kbt-walrus"]);
      const one = await json(await ONE.GET(req(`/api/kb/articles/${id}`), ctx(id)));
      expect(one.body.article.body).toBe("walrus plans");
    });

    it.each([
      ["a signed-out visitor", null, 401],
      ["a customer", ada, 403],
      ["an admin", root, 403],
    ] as const)("%s can't list, read, create, edit or delete (%i)", async (_label, who, code) => {
      const id = (await create(gina, draft)).body.article.id as string;
      as(who);
      expect((await ART.GET(req("/api/kb/articles"))).status).toBe(code);
      expect((await ONE.GET(req(`/api/kb/articles/${id}`), ctx(id))).status).toBe(code);
      expect((await ART.POST(req("/api/kb/articles", "POST", { title: "kbt nope", body: "x" }))).status).toBe(code);
      expect((await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { status: "published" }), ctx(id))).status).toBe(code);
      expect((await ONE.DELETE(req(`/api/kb/articles/${id}`, "DELETE"), ctx(id))).status).toBe(code);
      const row = (await sql`select status from kb_article where id = ${id}`)[0];
      expect(row?.status).toBe("draft");
      expect((await sql`select count(*)::int as n from kb_article where title = 'kbt nope'`)[0].n).toBe(0);
    });

    it("the data functions refuse non-agents on their own, not only the routes", async () => {
      for (const who of [ada, root]) {
        await expect(kb.createArticle(who, { title: "kbt x", body: "x" })).rejects.toMatchObject({ status: 403 });
        await expect(kb.listArticles(who)).rejects.toMatchObject({ status: 403 });
        await expect(kb.getArticle(who, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 403 });
        await expect(kb.updateArticle(who, "00000000-0000-4000-8000-000000000000", { title: "x" })).rejects.toMatchObject({ status: 403 });
        await expect(kb.deleteArticle(who, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 403 });
      }
    });

    it("mutations need our own Origin", async () => {
      as(gina);
      expect((await ART.POST(req("/api/kb/articles", "POST", draft, "https://evil.example"))).status).toBe(403);
      expect((await ART.POST(req("/api/kb/articles", "POST", draft, null))).status).toBe(403);
      const id = (await create(gina, draft)).body.article.id as string;
      as(gina);
      expect((await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { status: "published" }, "https://evil.example"), ctx(id))).status).toBe(403);
      expect((await ONE.DELETE(req(`/api/kb/articles/${id}`, "DELETE", undefined, null), ctx(id))).status).toBe(403);
      expect((await sql`select count(*)::int as n from kb_article where slug = 'kbt-walrus'`)[0].n).toBe(1);
    });
  });

  describe("validation and limits", () => {
    it("rejects a bad body: empty, over 10,000 characters, a title over 150, unknown fields, a bad slug or status", async () => {
      const bad: Record<string, unknown>[] = [
        { title: "", body: "x" },
        { title: "kbt ok", body: "" },
        { title: "kbt ok", body: "x".repeat(10_001) },
        { title: "x".repeat(151), body: "x" },
        { title: "kbt ok", body: "x", authorId: ada.id },
        { title: "kbt ok", body: "x", slug: "Not A Slug" },
        { title: "kbt ok", body: "x", slug: "-bad-" },
        { title: "kbt ok", body: "x", status: "archived" },
      ];
      for (const b of bad) expect((await create(gina, b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
      expect((await create(gina, { title: "kbt exactly", body: "x".repeat(10_000), slug: "kbt-max", status: "draft" })).status).toBe(201);
      as(gina);
      expect((await ART.POST(req("/api/kb/articles", "POST", "{nope"))).status).toBe(400);
      expect((await ART.POST(req("/api/kb/articles", "POST", { title: "kbt big", body: "x".repeat(40_000) }))).status).toBe(413);
    });

    it("PATCH takes title, body and status only, and something to change", async () => {
      const id = (await create(gina, { title: "kbt patchy", body: "x", slug: "kbt-patchy" })).body.article.id as string;
      as(gina);
      for (const b of [{}, { slug: "kbt-other" }, { authorId: ada.id }, { body: "x".repeat(10_001) }, { status: "nope" }]) {
        expect((await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", b), ctx(id))).status, JSON.stringify(b).slice(0, 40)).toBe(400);
      }
      expect((await sql`select slug, author_id from kb_article where id = ${id}`)[0]).toEqual({ slug: "kbt-patchy", author_id: gina.id });
    });

    it("derives a slug from the title and makes it unique; an explicit duplicate slug is 409", async () => {
      const a = await create(gina, { title: "kbt Café: Résumé & Tips!", body: "x" });
      expect(a.body.article.slug).toBe("kbt-cafe-resume-tips");
      const b = await create(gina, { title: "kbt Café: Résumé & Tips!", body: "x" });
      expect(b.body.article.slug).toBe("kbt-cafe-resume-tips-2");
      expect((await create(gina, { title: "other", body: "x", slug: "kbt-cafe-resume-tips" })).status).toBe(409);
      expect(kb.slugify("!!!")).toBe("article");
      expect(kb.slugify("x".repeat(300)).length).toBeLessThanOrEqual(100);
    });

    it("two parallel creates with the same title get different slugs", async () => {
      as(gina);
      const rs = await Promise.all([1, 2, 3].map(() => ART.POST(req("/api/kb/articles", "POST", { title: "kbt parallel", body: "x" }))));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
      const made = await sql`select slug from kb_article where slug like 'kbt-parallel%'`;
      expect(new Set(made.map((r) => r.slug)).size).toBe(3);
    });

    it("unknown or malformed ids are 404, the same answer", async () => {
      as(gina);
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1 or 1=1"]) {
        expect((await ONE.GET(req(`/api/kb/articles/x`), ctx(id))).status).toBe(404);
        expect((await ONE.PATCH(req(`/api/kb/articles/x`, "PATCH", { title: "kbt y" }), ctx(id))).status).toBe(404);
        expect((await ONE.DELETE(req(`/api/kb/articles/x`, "DELETE"), ctx(id))).status).toBe(404);
      }
    });

    it("caps the knowledge base at 500 articles", async () => {
      const [{ n }] = await sql`select count(*)::int as n from kb_article where slug not like 'kbt-%'`;
      const room = 500 - n;
      await sql`insert into kb_article (slug, title, body, status, author_id)
        select 'kbt-fill-' || g, 'kbt filler ' || g, 'filler', 'draft', ${gina.id} from generate_series(1, ${room}) g`;
      const full = await create(gina, { title: "kbt one too many", body: "x" });
      expect(full.status).toBe(409);
      expect(full.body.error).toMatch(/500/);
      // Editing still works at the cap, and deleting one makes room.
      const id = (await sql`select id from kb_article where slug = 'kbt-fill-1'`)[0].id as string;
      as(gina);
      expect((await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { title: "kbt edited" }), ctx(id))).status).toBe(200);
      expect((await ONE.DELETE(req(`/api/kb/articles/${id}`, "DELETE"), ctx(id))).status).toBe(204);
      expect((await create(gina, { title: "kbt now fits", body: "x" })).status).toBe(201);
    });

    it("limits an agent to 60 writes per hour, counting edits and deletes, per agent", async () => {
      const id = (await create(gina, { title: "kbt rate", body: "x", slug: "kbt-rate" })).body.article.id as string; // write 1
      for (let i = 0; i < 58; i++) await sql`insert into rate_event (user_id, kind) values (${gina.id}, 'kb_write')`; // 59 so far
      as(gina);
      expect((await ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { body: "y" }), ctx(id))).status).toBe(200); // 60th
      for (const attempt of [
        () => ONE.PATCH(req(`/api/kb/articles/${id}`, "PATCH", { body: "z" }), ctx(id)),
        () => ART.POST(req("/api/kb/articles", "POST", { title: "kbt 61", body: "x" })),
        () => ONE.DELETE(req(`/api/kb/articles/${id}`, "DELETE"), ctx(id)),
      ]) {
        const res = await attempt();
        expect(res.status).toBe(429);
      }
      expect((await sql`select body from kb_article where id = ${id}`)[0].body).toBe("y");
      // Another agent has their own allowance, and a refused write doesn't use any of it.
      expect((await create(hank, { title: "kbt hank ok", body: "x" })).status).toBe(201);
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${gina.id} and kind = 'kb_write'`)[0].n).toBe(60);
    });
  });
});
