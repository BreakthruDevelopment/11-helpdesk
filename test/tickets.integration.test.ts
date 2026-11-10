/**
 * Ticket access rules against a real Postgres (TEST_DATABASE_URL), through the real route handlers (only the session
 * lookup is replaced, so each request runs as a chosen user). Every rule is tested for the customer who owns the
 * ticket, another customer, an agent and an admin; internal-note leakage is checked on every route and in the outbox.
 */
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
const NOTE = "INTERNAL-NOTE-CANARY customer is on a legacy discount";

const mk = (id: string, role: Role): Who => ({ id, name: `${id} name`, email: `${id}@test.local`, role });
const ada = mk("tk-ada", "user");
const bob = mk("tk-bob", "user");
const gina = mk("tk-gina", "agent");
const hank = mk("tk-hank", "agent");
const root = mk("tk-root", "admin");
const everyone = [ada, bob, gina, hank, root];

describe.skipIf(!url)("tickets: access rules (Postgres)", () => {
  let sql: postgres.Sql;
  let T: typeof import("@/app/api/tickets/route");
  let TID: typeof import("@/app/api/tickets/[id]/route");
  let MSG: typeof import("@/app/api/tickets/[id]/messages/route");
  let TRIAGE: typeof import("@/app/api/tickets/[id]/triage/route");
  let INBOX: typeof import("@/app/api/inbox/route");
  let READ: typeof import("@/app/api/inbox/read/route");
  let STATS: typeof import("@/app/api/admin/stats/route");

  const as = (who: Who | null) => void (current.actor = who);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  function req(path: string, method = "GET", body?: unknown, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  }
  async function json(res: Response) {
    return { status: res.status, text: await res.clone().text(), body: (await res.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async function open(who: Who, subject = "Printer on fire", body = "It is smoking.") {
    as(who);
    const r = await json(await T.POST(req("/api/tickets", "POST", { subject, body })));
    expect(r.status).toBe(201);
    return r.body.ticket.id as string;
  }
  async function post(who: Who, id: string, body: Record<string, unknown>) {
    as(who);
    return json(await MSG.POST(req(`/api/tickets/${id}/messages`, "POST", body), ctx(id)));
  }
  async function patch(who: Who, id: string, body: unknown) {
    as(who);
    return json(await TID.PATCH(req(`/api/tickets/${id}`, "PATCH", body), ctx(id)));
  }
  async function get(who: Who, id: string) {
    as(who);
    return json(await TID.GET(req(`/api/tickets/${id}`), ctx(id)));
  }
  const row = async (id: string) => (await sql`select * from ticket where id = ${id}`)[0];

  async function clean() {
    await sql`delete from "user" where id like 'tk-%'`;
    await sql`delete from rate_event where user_id like 'tk-%'`;
  }

  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: url, BETTER_AUTH_SECRET: "tickets-integration-secret-32-chars-x", APP_URL: ORIGIN, LOG_LEVEL: "error", NODE_ENV: "test" });
    (await import("@/lib/env")).resetEnvCache();
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await clean();
    for (const u of everyone) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role})`;
    T = await import("@/app/api/tickets/route");
    TID = await import("@/app/api/tickets/[id]/route");
    MSG = await import("@/app/api/tickets/[id]/messages/route");
    TRIAGE = await import("@/app/api/tickets/[id]/triage/route");
    INBOX = await import("@/app/api/inbox/route");
    READ = await import("@/app/api/inbox/read/route");
    STATS = await import("@/app/api/admin/stats/route");
  });
  afterAll(async () => {
    await clean();
    await sql.end();
  });
  beforeEach(async () => {
    as(null);
    await sql`delete from rate_event where user_id like 'tk-%'`;
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("creating a ticket", () => {
    it("a customer opens a ticket: first public message, server-set due times, status new, a receipt in the outbox", async () => {
      const id = await open(ada, "Cannot log in", "The page says invalid password.");
      const t = await row(id);
      expect(t.customer_id).toBe(ada.id);
      expect(t.status).toBe("new");
      expect(t.priority).toBe("normal");
      expect(t.triage_source).toBe("none");
      expect(t.version).toBe(1);
      expect(new Date(t.first_response_due_at).getTime() - new Date(t.created_at).getTime()).toBe(8 * 3_600_000);
      expect(new Date(t.resolution_due_at).getTime() - new Date(t.created_at).getTime()).toBe(72 * 3_600_000);
      const msgs = await sql`select visibility, author_role, body from ticket_message where ticket_id = ${id}`;
      expect(msgs).toEqual([{ visibility: "public", author_role: "customer", body: "The page says invalid password." }]);
      const mail = await sql`select recipient_id, kind from mail_message where ticket_id = ${id}`;
      expect(mail).toEqual([{ recipient_id: ada.id, kind: "ticket_created" }]);
    });

    it("the customer chooses nothing but subject and body: priority, status, customer and due times are refused", async () => {
      as(ada);
      const before = (await sql`select count(*)::int as n from ticket where customer_id = ${ada.id}`)[0].n;
      for (const extra of [{ priority: "urgent" }, { status: "resolved" }, { customerId: bob.id }, { firstResponseDueAt: "2000-01-01" }, { visibility: "internal" }]) {
        const r = await json(await T.POST(req("/api/tickets", "POST", { subject: "s", body: "b", ...extra })));
        expect(r.status).toBe(400);
      }
      expect((await sql`select count(*)::int as n from ticket where customer_id = ${ada.id}`)[0].n).toBe(before);
    });

    it("validates input: empty, over-long, wrong types, bad JSON, oversize body", async () => {
      as(ada);
      const before = (await sql`select count(*)::int as n from ticket where customer_id = ${ada.id}`)[0].n;
      const bad: unknown[] = [{ subject: "", body: "x" }, { subject: "x", body: "" }, { subject: "s".repeat(151), body: "x" }, { subject: "x", body: "b".repeat(5001) }, { subject: 5, body: "x" }, {}, []];
      for (const body of bad) expect((await json(await T.POST(req("/api/tickets", "POST", body)))).status).toBe(400);
      expect((await json(await T.POST(req("/api/tickets", "POST", "{nope")))).status).toBe(400);
      expect((await json(await T.POST(req("/api/tickets", "POST", "x".repeat(40_000))))).status).toBe(413);
      expect((await sql`select count(*)::int as n from ticket where customer_id = ${ada.id}`)[0].n).toBe(before);
    });

    it("an agent can't open tickets (403) and an admin gets 404; nothing is stored", async () => {
      as(gina);
      expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "s", body: "b" })))).status).toBe(403);
      as(root);
      expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "s", body: "b" })))).status).toBe(404);
      expect(await sql`select 1 from ticket where customer_id in (${gina.id}, ${root.id})`).toHaveLength(0);
    });

    it("limits: 5 per hour (429, nothing stored), 20 per day, 50 open", async () => {
      for (let i = 0; i < 5; i++) await open(bob, `t${i}`);
      as(bob);
      const r = await json(await T.POST(req("/api/tickets", "POST", { subject: "sixth", body: "b" })));
      expect(r.status).toBe(429);
      expect(await sql`select 1 from ticket where customer_id = ${bob.id}`).toHaveLength(5);

      await sql`delete from rate_event where user_id = ${bob.id}`;
      await sql`insert into rate_event (user_id, kind) select ${bob.id}, 'ticket_day' from generate_series(1, 20)`;
      expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "daily", body: "b" })))).status).toBe(429);

      await sql`delete from rate_event where user_id = ${bob.id}`;
      await sql`delete from ticket where customer_id = ${bob.id}`;
      await sql`insert into ticket (customer_id, subject, status, first_response_due_at, resolution_due_at)
                select ${bob.id}, 'filler ' || g, 'open', now(), now() from generate_series(1, 50) g`;
      const capped = await json(await T.POST(req("/api/tickets", "POST", { subject: "fifty-first", body: "b" })));
      expect(capped.status).toBe(409);
      // Resolved tickets don't count toward the cap.
      await sql`update ticket set status = 'resolved', resolved_at = now() where id in (select id from ticket where customer_id = ${bob.id} limit 1)`;
      await sql`delete from rate_event where user_id = ${bob.id}`;
      expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "now fits", body: "b" })))).status).toBe(201);
      await sql`delete from ticket where customer_id = ${bob.id}`;
    });

    it("concurrent creates can't slip past the hourly limit", async () => {
      as(bob);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => T.POST(req("/api/tickets", "POST", { subject: `race ${i}`, body: "b" }))));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
      expect(await sql`select 1 from ticket where customer_id = ${bob.id}`).toHaveLength(5);
      await sql`delete from ticket where customer_id = ${bob.id}`;
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("the customer wall", () => {
    let adaTicket: string;
    beforeAll(async () => {
      adaTicket = await open(ada, "Ada's private subject", "Ada's private body");
    });

    it("another customer gets 404 (never 403) on every route, for a real id, a random id and a malformed id", async () => {
      const random = "7f0c1d9e-7a3b-4c52-9d8e-0a1b2c3d4e5f";
      for (const id of [adaTicket, random, "not-a-uuid", "1' or '1'='1"]) {
        expect((await get(bob, id)).status).toBe(404);
        expect((await patch(bob, id, { action: "resolve" })).status).toBe(404);
        expect((await post(bob, id, { body: "let me in" })).status).toBe(404);
      }
      const t = await row(adaTicket);
      expect(t.status).toBe("new");
      expect(await sql`select 1 from ticket_message where ticket_id = ${adaTicket}`).toHaveLength(1);
    });

    it("another customer's list is empty of Ada's tickets and contains none of her text", async () => {
      as(bob);
      const r = await json(await T.GET(req("/api/tickets")));
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("Ada's private");
      expect(r.body.tickets.map((t: { id: string }) => t.id)).not.toContain(adaTicket);
    });

    it("the owner reads their ticket; the response is an allow-list with no staff-only fields", async () => {
      const r = await get(ada, adaTicket);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body.ticket).sort()).toEqual(["createdAt", "followUp", "id", "number", "resolvedAt", "status", "subject", "updatedAt"]);
      expect(Object.keys(r.body.messages[0]).sort()).toEqual(["authorRole", "body", "createdAt", "id", "mine"]);
      for (const secret of ["assignee", "triage", "version", "priority", "category", "DueAt", "paused", "breached", "customerId", "aiAssisted", "authorId", "visibility"]) {
        expect(r.text).not.toContain(secret);
      }
      as(ada);
      const list = await json(await T.GET(req("/api/tickets")));
      expect(Object.keys(list.body.tickets[0]).sort()).toEqual(["createdAt", "followUp", "id", "number", "resolvedAt", "status", "subject", "updatedAt"]);
    });

    it("a customer can't read the queue filters or agent data: view/status params only narrow their own tickets", async () => {
      as(bob);
      const r = await json(await T.GET(req("/api/tickets?view=all&status=new&limit=100")));
      expect(r.body.tickets.map((t: { id: string }) => t.id)).not.toContain(adaTicket);
    });

    it("a customer's PATCH can only be { action: 'resolve' }; agent fields are a 403 and change nothing", async () => {
      for (const body of [{ version: 1, priority: "urgent" }, { status: "resolved" }, { action: "resolve", assigneeId: gina.id }, { version: 1, assigneeId: ada.id }]) {
        expect((await patch(ada, adaTicket, body)).status).toBe(403);
      }
      expect((await patch(ada, adaTicket, { action: "close" })).status).toBe(400);
      const t = await row(adaTicket);
      expect([t.status, t.priority, t.assignee_id, t.version]).toEqual(["new", "normal", null, 1]);
    });

    it("an admin gets 404 on every content route, but not on stats", async () => {
      expect((await get(root, adaTicket)).status).toBe(404);
      expect((await patch(root, adaTicket, { version: 1, priority: "low" })).status).toBe(404);
      expect((await post(root, adaTicket, { body: "x" })).status).toBe(404);
      as(root);
      expect((await json(await T.GET(req("/api/tickets")))).status).toBe(404);
      expect((await json(await STATS.GET())).status).toBe(200);
      expect((await row(adaTicket)).priority).toBe("normal");
    });

    it("signed-out requests get 401 on every route", async () => {
      as(null);
      expect((await json(await T.GET(req("/api/tickets")))).status).toBe(401);
      expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "s", body: "b" })))).status).toBe(401);
      expect((await json(await TID.GET(req("/x"), ctx(adaTicket)))).status).toBe(401);
      expect((await json(await TID.PATCH(req("/x", "PATCH", { action: "resolve" }), ctx(adaTicket)))).status).toBe(401);
      expect((await json(await MSG.POST(req("/x", "POST", { body: "b" }), ctx(adaTicket)))).status).toBe(401);
      expect((await json(await INBOX.GET())).status).toBe(401);
      expect((await json(await READ.POST(req("/x", "POST", { all: true })))).status).toBe(401);
      expect((await json(await STATS.GET())).status).toBe(401);
    });

    it("mutating routes refuse a missing or foreign Origin (403) before touching anything", async () => {
      as(ada);
      for (const origin of [null, "https://evil.example", "http://localhost:3001"]) {
        expect((await json(await T.POST(req("/api/tickets", "POST", { subject: "s", body: "b" }, origin)))).status).toBe(403);
        expect((await json(await TID.PATCH(req("/x", "PATCH", { action: "resolve" }, origin), ctx(adaTicket)))).status).toBe(403);
        expect((await json(await MSG.POST(req("/x", "POST", { body: "b" }, origin), ctx(adaTicket)))).status).toBe(403);
        expect((await json(await READ.POST(req("/x", "POST", { all: true }, origin)))).status).toBe(403);
        expect((await json(await TRIAGE.POST(req("/x", "POST", {}, origin)))).status).toBe(403);
      }
      expect((await row(adaTicket)).status).toBe("new");
    });

    it("the triage route is agent-only: 403 for customers and admins (even for the owner), 501 until issue 11.3 for agents", async () => {
      for (const who of [ada, bob, root]) {
        as(who);
        expect((await json(await TRIAGE.POST(req(`/api/tickets/${adaTicket}/triage`, "POST", {})))).status).toBe(403);
      }
      as(gina);
      expect((await json(await TRIAGE.POST(req(`/api/tickets/${adaTicket}/triage`, "POST", {})))).status).toBe(501);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("agents", () => {
    it("see every ticket from every customer, with internal notes and customer names", async () => {
      const a = await open(ada, "Ada subject");
      const b = await open(bob, "Bob subject");
      expect((await post(gina, a, { body: NOTE, visibility: "internal" })).status).toBe(201);
      as(hank);
      const list = await json(await T.GET(req("/api/tickets?view=all&limit=100")));
      const ids = list.body.tickets.map((t: { id: string }) => t.id);
      expect(ids).toEqual(expect.arrayContaining([a, b]));
      expect(list.body.tickets.find((t: { id: string }) => t.id === a)).toMatchObject({ customerName: ada.name, version: 1, priority: "normal" });
      const detail = await get(hank, a);
      expect(detail.status).toBe(200);
      expect(detail.body.messages.map((m: { visibility: string }) => m.visibility)).toEqual(["public", "internal"]);
      expect(detail.body.messages[1]).toMatchObject({ body: NOTE, authorName: gina.name });
    });

    it("the queue views: unassigned excludes assigned and resolved; mine shows only mine", async () => {
      const u = await open(ada, "unassigned one");
      const m = await open(ada, "mine one");
      const r = await open(ada, "resolved one");
      expect((await patch(gina, m, { version: 1, assigneeId: gina.id })).status).toBe(200);
      expect((await patch(hank, r, { version: 1, status: "resolved" })).status).toBe(200);
      as(gina);
      const un = (await json(await T.GET(req("/api/tickets?view=unassigned&limit=100")))).body.tickets.map((t: { id: string }) => t.id);
      expect(un).toContain(u);
      expect(un).not.toContain(m);
      expect(un).not.toContain(r);
      const mine = (await json(await T.GET(req("/api/tickets?view=mine&limit=100")))).body.tickets.map((t: { id: string }) => t.id);
      expect(mine).toContain(m);
      expect(mine).not.toContain(u);
      expect((await json(await T.GET(req("/api/tickets?view=bogus")))).status).toBe(400);
    });

    it("write public replies and internal notes; both are stored with the author's role", async () => {
      const id = await open(ada);
      expect((await post(gina, id, { body: "Public reply" })).status).toBe(201);
      expect((await post(gina, id, { body: "Private note", visibility: "internal" })).status).toBe(201);
      const rows = await sql`select visibility, author_role, ai_assisted from ticket_message where ticket_id = ${id} order by created_at`;
      expect(rows.map((r) => [r.visibility, r.author_role])).toEqual([["public", "customer"], ["public", "agent"], ["internal", "agent"]]);
    });

    it("records ai_assisted on a sent message", async () => {
      const id = await open(ada);
      const r = await post(gina, id, { body: "Drafted by AI, edited by me", aiAssisted: true });
      expect(r.body.message.aiAssisted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("internal notes never reach a customer", () => {
    let id: string;
    beforeAll(async () => {
      id = await open(ada, "Billing question", "Why was I charged twice?");
      expect((await patch(gina, id, { version: 1, assigneeId: gina.id })).status).toBe(200);
      expect((await post(gina, id, { body: NOTE, visibility: "internal" })).status).toBe(201);
      expect((await post(gina, id, { body: "Hi Ada, I'm looking into the double charge." })).status).toBe(201);
      expect((await post(gina, id, { body: `${NOTE} (second note)`, visibility: "internal" })).status).toBe(201);
    });

    it("the ticket thread: the owner sees the public reply and not a trace of any note", async () => {
      const r = await get(ada, id);
      expect(r.body.messages.map((m: { body: string }) => m.body)).toEqual(["Why was I charged twice?", "Hi Ada, I'm looking into the double charge."]);
      expect(r.text).not.toContain("CANARY");
      expect(r.text).not.toContain("legacy discount");
    });

    it("the list, the inbox, and every write response omit the notes", async () => {
      as(ada);
      for (const r of [await json(await T.GET(req("/api/tickets"))), await json(await INBOX.GET())]) {
        expect(r.status).toBe(200);
        expect(r.text).not.toContain("CANARY");
      }
      const reply = await post(ada, id, { body: "Thanks, any news?" });
      expect(reply.status).toBe(201);
      expect(reply.text).not.toContain("CANARY");
      const resolved = await patch(ada, id, { action: "resolve" });
      expect(resolved.status).toBe(200);
      expect(resolved.text).not.toContain("CANARY");
      await patch(gina, id, { version: (await row(id)).version, status: "open" });
    });

    it("the outbox: no mail_message row, for any recipient, contains note text; a note creates none", async () => {
      const before = (await sql`select count(*)::int as n from mail_message where ticket_id = ${id}`)[0].n;
      expect((await post(gina, id, { body: "NOTE-ONLY-CANARY", visibility: "internal" })).status).toBe(201);
      expect((await sql`select count(*)::int as n from mail_message where ticket_id = ${id}`)[0].n).toBe(before);
      const leaked = await sql`
        select id from mail_message
        where subject ilike '%CANARY%' or snippet ilike '%CANARY%' or subject ilike '%legacy discount%' or snippet ilike '%legacy discount%'`;
      expect(leaked).toHaveLength(0);
      const kinds = await sql`select recipient_id, kind, snippet from mail_message where ticket_id = ${id} order by created_at`;
      expect(kinds.find((m) => m.kind === "agent_reply")).toMatchObject({ recipient_id: ada.id, snippet: "Hi Ada, I'm looking into the double charge." });
    });

    it("a customer can't write an internal note or an AI-assisted message: 403 and nothing stored", async () => {
      const before = (await sql`select count(*)::int as n from ticket_message where ticket_id = ${id}`)[0].n;
      expect((await post(ada, id, { body: "sneaky", visibility: "internal" })).status).toBe(403);
      expect((await post(ada, id, { body: "sneaky", aiAssisted: true })).status).toBe(403);
      expect((await sql`select count(*)::int as n from ticket_message where ticket_id = ${id}`)[0].n).toBe(before);
    });

    it("the database itself refuses a customer-authored internal message and a message under the wrong customer", async () => {
      await expect(sql`insert into ticket_message (ticket_id, customer_id, author_role, visibility, body) values (${id}, ${ada.id}, 'customer', 'internal', 'x')`).rejects.toMatchObject({ constraint_name: "ticket_message_internal_agent_chk" });
      await expect(sql`insert into ticket_message (ticket_id, customer_id, author_role, visibility, body) values (${id}, ${bob.id}, 'agent', 'public', 'x')`).rejects.toMatchObject({ constraint_name: "ticket_message_ticket_customer_fk" });
    });

    it("a public reply with a 5,000 character body gets a snippet of at most 200 characters and a subject of at most 150", async () => {
      const long = await open(bob, "s".repeat(150), "first");
      expect((await post(gina, long, { body: "w".repeat(5000) })).status).toBe(201);
      const rows = await sql`select max(char_length(snippet)) as s, max(char_length(subject)) as j from mail_message where ticket_id = ${long}`;
      expect(rows[0].s).toBeLessThanOrEqual(200);
      expect(rows[0].j).toBeLessThanOrEqual(150);
      await sql`delete from ticket where id = ${long}`;
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("the outbox and inbox", () => {
    it("a rolled-back event leaves no notification (same transaction)", async () => {
      const id = await open(ada);
      const { db } = await import("@/lib/db");
      const { mailer } = await import("@/lib/mail/outbox");
      const before = (await sql`select count(*)::int as n from mail_message`)[0].n;
      await expect(
        db().transaction(async (tx) => {
          await mailer().send(tx, { recipientId: ada.id, kind: "agent_reply", ticketId: id, subject: "s", snippet: "n" });
          throw new Error("event failed");
        }),
      ).rejects.toThrow("event failed");
      expect((await sql`select count(*)::int as n from mail_message`)[0].n).toBe(before);
    });

    it("events: created (customer), agent public reply (customer), assignment (assignee), resolved by an agent (customer), customer reply (assignee)", async () => {
      const id = await open(bob, "Events");
      await patch(gina, id, { version: 1, assigneeId: hank.id });
      await post(gina, id, { body: "agent says hi" });
      await post(bob, id, { body: "customer says hi" });
      await patch(gina, id, { version: (await row(id)).version, status: "resolved" });
      const mail = await sql`select recipient_id, kind from mail_message where ticket_id = ${id} order by created_at`;
      expect(mail.map((m) => `${m.recipient_id}:${m.kind}`)).toEqual([
        `${bob.id}:ticket_created`,
        `${hank.id}:ticket_assigned`,
        `${bob.id}:agent_reply`,
        `${hank.id}:customer_reply`,
        `${bob.id}:ticket_resolved`,
      ]);
      // Assigning a ticket to yourself notifies nobody.
      const mine = await open(bob, "Self assign");
      await patch(gina, mine, { version: 1, assigneeId: gina.id });
      expect(await sql`select 1 from mail_message where ticket_id = ${mine} and kind = 'ticket_assigned'`).toHaveLength(0);
    });

    it("a recipient reads only their own notifications; another user's ids match nothing", async () => {
      const id = await open(ada, "Inbox mine");
      await post(gina, id, { body: "reply for ada" });
      as(bob);
      const bobs = await json(await INBOX.GET());
      expect(bobs.text).not.toContain("reply for ada");
      const adas = (await sql`select id from mail_message where recipient_id = ${ada.id} and ticket_id = ${id}`).map((r) => r.id);
      const attempt = await json(await READ.POST(req("/api/inbox/read", "POST", { ids: adas })));
      expect(attempt.body.marked).toBe(0);
      expect((await sql`select 1 from mail_message where id = any(${adas}) and read_at is not null`)).toHaveLength(0);
      as(ada);
      const mine = await json(await INBOX.GET());
      expect(mine.body.messages.length).toBeGreaterThanOrEqual(2);
      expect(mine.body.unread).toBe(mine.body.messages.length);
      const marked = await json(await READ.POST(req("/api/inbox/read", "POST", { ids: adas })));
      expect(marked.body.marked).toBe(adas.length);
      expect((await json(await READ.POST(req("/api/inbox/read", "POST", { all: true })))).body.unread).toBe(0);
    });

    it("validates inbox input and gives agents and admins an inbox of their own", async () => {
      as(ada);
      for (const body of [{}, { ids: [] }, { ids: ["nope"] }, { all: false }, { all: true, extra: 1 }]) {
        expect((await json(await READ.POST(req("/api/inbox/read", "POST", body)))).status).toBe(400);
      }
      as(root);
      expect((await json(await INBOX.GET())).body).toEqual({ messages: [], unread: 0 });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("status, SLA clocks and versions", () => {
    it("an agent's first public reply stamps the first response and opens a new ticket; a note does neither", async () => {
      const id = await open(ada);
      await post(gina, id, { body: "internal first", visibility: "internal" });
      let t = await row(id);
      expect([t.status, t.first_responded_at]).toEqual(["new", null]);
      await post(gina, id, { body: "hello" });
      t = await row(id);
      expect(t.status).toBe("open");
      expect(t.first_responded_at).not.toBeNull();
      const stamped = t.first_responded_at;
      await post(hank, id, { body: "another" });
      expect((await row(id)).first_responded_at).toEqual(stamped);
    });

    it("pending_customer pauses the resolution clock; the customer's reply resumes it and moves the deadline by the wait", async () => {
      const id = await open(ada);
      const before = await row(id);
      expect((await patch(gina, id, { version: 1, status: "pending_customer" })).status).toBe(200);
      let t = await row(id);
      expect(t.paused_at).not.toBeNull();
      // Pretend the ticket has been waiting on the customer for two hours.
      await sql`update ticket set paused_at = now() - interval '2 hours' where id = ${id}`;
      expect((await post(ada, id, { body: "here is the info" })).status).toBe(201);
      t = await row(id);
      expect(t.status).toBe("open");
      expect(t.paused_at).toBeNull();
      expect(t.paused_seconds).toBeGreaterThanOrEqual(7200);
      expect(t.paused_seconds).toBeLessThan(7210);
      expect(new Date(t.resolution_due_at).getTime() - new Date(before.resolution_due_at).getTime()).toBe(t.paused_seconds * 1000);
    });

    it("an agent moving the ticket out of pending_customer also resumes the clock, and a priority change recomputes from created_at plus the wait", async () => {
      const id = await open(ada);
      await patch(gina, id, { version: 1, status: "pending_customer" });
      await sql`update ticket set paused_at = now() - interval '3 hours' where id = ${id}`;
      const r = await patch(gina, id, { version: 2, status: "open", priority: "urgent" });
      expect(r.status).toBe(200);
      const t = await row(id);
      expect(t.paused_at).toBeNull();
      expect(t.triage_source).toBe("agent");
      const created = new Date(t.created_at).getTime();
      expect(new Date(t.first_response_due_at).getTime() - created).toBe(1 * 3_600_000);
      expect(new Date(t.resolution_due_at).getTime() - created).toBe(8 * 3_600_000 + t.paused_seconds * 1000);
    });

    it("breaches are stamped lazily on read, idempotently, and a late first response still leaves its breach on record", async () => {
      const lazy = await open(ada, "lazy");
      const late = await open(ada, "late");
      await sql`update ticket set first_response_due_at = now() - interval '1 hour' where id in (${lazy}, ${late})`;
      expect((await row(lazy)).breached_first_response_at).toBeNull();
      await get(ada, lazy); // any read stamps
      const stamped = (await row(lazy)).breached_first_response_at;
      expect(stamped).not.toBeNull();
      await get(ada, lazy);
      expect((await row(lazy)).breached_first_response_at).toEqual(stamped);
      // Nobody looked at `late` before the agent answered it.
      await post(gina, late, { body: "sorry for the wait" });
      const t = await row(late);
      expect(t.breached_first_response_at).not.toBeNull();
      expect(t.first_responded_at).not.toBeNull();
    });

    it("a paused ticket is not breaching its resolution clock; a running one past due is", async () => {
      const paused = await open(ada, "paused");
      const running = await open(ada, "running");
      await patch(gina, paused, { version: 1, status: "pending_customer" });
      await sql`update ticket set resolution_due_at = now() - interval '1 hour' where id in (${paused}, ${running})`;
      await get(ada, paused);
      expect((await row(paused)).breached_resolution_at).toBeNull();
      expect((await row(running)).breached_resolution_at).not.toBeNull();
    });

    it("a stale version is a 409 and changes nothing; the current version succeeds and moves to the next", async () => {
      const id = await open(ada);
      expect((await patch(gina, id, { version: 1, priority: "high" })).status).toBe(200);
      const stale = await patch(hank, id, { version: 1, priority: "low", category: "billing" });
      expect(stale.status).toBe(409);
      let t = await row(id);
      expect([t.priority, t.category, t.version]).toEqual(["high", "other", 2]);
      const ok = await patch(hank, id, { version: 2, category: "billing" });
      expect(ok.status).toBe(200);
      expect(ok.body.ticket).toMatchObject({ category: "billing", version: 3 });
      t = await row(id);
      expect(t.triage_source).toBe("agent");
    });

    it("concurrent updates with the same version: exactly one wins", async () => {
      const id = await open(ada);
      as(gina);
      const results = await Promise.all(
        ["high", "low", "urgent", "normal"].map((priority) => TID.PATCH(req(`/api/tickets/${id}`, "PATCH", { version: 1, priority }), ctx(id))),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect((await row(id)).version).toBe(2);
    });

    it("validates agent patches: unknown keys, status new, bad values, no change, missing version", async () => {
      const id = await open(ada);
      for (const body of [{ version: 1, status: "new" }, { version: 1, priority: "critical" }, { version: 1, category: "x" }, { version: 1 }, { priority: "low" }, { version: 0, priority: "low" }, { version: 1, priority: "low", customerId: bob.id }, { version: 1, version2: 1, priority: "low" }]) {
        expect((await patch(gina, id, body)).status).toBe(400);
      }
      expect((await row(id)).version).toBe(1);
    });

    it("status moves follow new -> open -> pending_customer <-> open -> resolved; resolved only reopens", async () => {
      const id = await open(ada);
      expect((await patch(gina, id, { version: 1, status: "resolved" })).status).toBe(200);
      expect((await patch(gina, id, { version: 2, status: "pending_customer" })).status).toBe(409);
      expect((await patch(gina, id, { version: 2, status: "open" })).status).toBe(200);
      expect((await row(id)).resolved_at).toBeNull();
      // Setting the status it already has is not a change.
      expect((await patch(gina, id, { version: 3, status: "open", priority: "high" })).status).toBe(200);
    });

    it("assignment: only to a real agent (not a customer, an admin, a stranger); claiming a new ticket opens it; null unassigns", async () => {
      const id = await open(ada);
      for (const assigneeId of [ada.id, root.id, "nobody"]) expect((await patch(gina, id, { version: 1, assigneeId })).status).toBe(400);
      expect((await patch(gina, id, { version: 1, assigneeId: hank.id })).body.ticket).toMatchObject({ assigneeId: hank.id, status: "open", version: 2 });
      expect((await patch(gina, id, { version: 2, assigneeId: null })).body.ticket.assigneeId).toBeNull();
    });

    it("the customer marks their own ticket resolved (idempotent), and a reply within 7 days reopens it", async () => {
      const id = await open(ada);
      const r = await patch(ada, id, { action: "resolve" });
      expect(r.status).toBe(200);
      expect(r.body.ticket.status).toBe("resolved");
      const version = (await row(id)).version;
      expect((await patch(ada, id, { action: "resolve" })).status).toBe(200);
      expect((await row(id)).version).toBe(version);
      await sql`update ticket set resolved_at = now() - interval '6 days' where id = ${id}`;
      expect((await post(ada, id, { body: "it came back" })).status).toBe(201);
      const t = await row(id);
      expect([t.status, t.resolved_at]).toEqual(["open", null]);
    });

    it("after 7 days a customer reply is a 409 ('open a follow-up') and the list says so", async () => {
      const id = await open(ada);
      await patch(ada, id, { action: "resolve" });
      await sql`update ticket set resolved_at = now() - interval '8 days' where id = ${id}`;
      const r = await post(ada, id, { body: "too late" });
      expect(r.status).toBe(409);
      expect((await row(id)).status).toBe("resolved");
      expect((await get(ada, id)).body.ticket.followUp).toBe(true);
    });

    it("an agent can still add a note or a reply to a resolved ticket without reopening it", async () => {
      const id = await open(ada);
      await patch(ada, id, { action: "resolve" });
      expect((await post(gina, id, { body: "closing note", visibility: "internal" })).status).toBe(201);
      expect((await row(id)).status).toBe("resolved");
    });

    it("message limits: 60 per hour (429), body at most 5,000 characters, strict keys", async () => {
      const id = await open(ada);
      expect((await post(ada, id, { body: "b".repeat(5001) })).status).toBe(400);
      expect((await post(ada, id, { body: "" })).status).toBe(400);
      expect((await post(ada, id, { body: "x", visibility: "secret" })).status).toBe(400);
      expect((await post(ada, id, { body: "x", authorId: bob.id })).status).toBe(400);
      await sql`insert into rate_event (user_id, kind) select ${ada.id}, 'message' from generate_series(1, 60)`;
      expect((await post(ada, id, { body: "one too many" })).status).toBe(429);
      expect(await sql`select 1 from ticket_message where ticket_id = ${id} and body = 'one too many'`).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("admin counts", () => {
    it("only an admin reads them; they are numbers, never ticket content", async () => {
      await open(ada, "Secret subject for stats", "Secret body for stats");
      for (const who of [ada, gina]) {
        as(who);
        expect((await json(await STATS.GET())).status).toBe(403);
      }
      as(root);
      const r = await json(await STATS.GET());
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("Secret");
      expect(r.body.tickets.total).toBeGreaterThan(0);
      expect(Object.keys(r.body).sort()).toEqual(["ai", "slaBreaches", "tickets", "users"]);
      expect(r.body.ai.dailyCap).toBe(400);
      expect(r.body.users.agents).toBeGreaterThanOrEqual(2);
    });

    it("SLA breach counts include breaches nobody has stamped yet", async () => {
      const id = await open(ada, "unstamped");
      as(root);
      const before = (await json(await STATS.GET())).body.slaBreaches.firstResponse as number;
      await sql`update ticket set first_response_due_at = now() - interval '1 minute' where id = ${id}`;
      // Direct count, without the stamping the endpoint runs first: the predicate alone must catch it.
      const [{ n }] = await sql`select count(*)::int as n from ticket where breached_first_response_at is not null or (first_responded_at is null and first_response_due_at < now())`;
      expect(n).toBeGreaterThan(0);
      expect((await json(await STATS.GET())).body.slaBreaches.firstResponse).toBe(before + 1);
    });
  });
});
