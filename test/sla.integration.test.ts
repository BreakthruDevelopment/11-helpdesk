/**
 * The SLA engine against a real Postgres (TEST_DATABASE_URL): the queue is ordered by what is ticking, agents get the
 * computed state with every ticket and customers never see it, and lazy breach stamping is idempotent for every kind
 * of row. The pure arithmetic is in src/lib/sla.test.ts; the pause, resume and priority transitions through the
 * routes are in tickets.integration.test.ts.
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
const mk = (id: string, role: Role): Who => ({ id, name: `${id} name`, email: `${id}@test.local`, role });
const cust = mk("sla-cust", "user");
const agent = mk("sla-agent", "agent");
const root = mk("sla-root", "admin");

describe.skipIf(!url)("SLA engine (Postgres)", () => {
  let sql: postgres.Sql;
  let T: typeof import("@/app/api/tickets/route");
  let TID: typeof import("@/app/api/tickets/[id]/route");
  let slaDb: typeof import("@/lib/sla-db");
  let dbMod: typeof import("@/lib/db");

  const as = (who: Who | null) => void (current.actor = who);
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;

  /** Insert a ticket with exact clocks. Offsets are hours from now (negative = past). */
  async function make(
    label: string,
    o: {
      status?: "new" | "open" | "pending_customer" | "resolved";
      createdH?: number;
      firstDueH: number;
      resDueH: number;
      answeredH?: number;
      resolvedH?: number;
      pausedH?: number;
      breachedFirst?: boolean;
      breachedRes?: boolean;
    },
  ): Promise<string> {
    const h = (n: number) => sql`now() + ${n} * interval '1 hour'`;
    const [r] = await sql`
      insert into ticket (customer_id, subject, status, created_at, updated_at, public_activity_at, first_response_due_at, resolution_due_at,
        first_responded_at, resolved_at, paused_at, breached_first_response_at, breached_resolution_at)
      values (${cust.id}, ${`sla-${label}`}, ${o.status ?? "open"}, ${h(o.createdH ?? -1)}, ${h(o.createdH ?? -1)}, ${h(o.createdH ?? -1)},
        ${h(o.firstDueH)}, ${h(o.resDueH)},
        ${o.answeredH === undefined ? null : h(o.answeredH)}, ${o.resolvedH === undefined ? null : h(o.resolvedH)},
        ${o.pausedH === undefined ? null : h(o.pausedH)},
        ${o.breachedFirst ? h(o.firstDueH) : null}, ${o.breachedRes ? h(o.resDueH) : null})
      returning id`;
    return r.id as string;
  }
  const row = async (id: string) => (await sql`select * from ticket where id = ${id}`)[0];
  const clean = async () => {
    await sql`delete from "user" where id like 'sla-%'`;
  };

  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: url, BETTER_AUTH_SECRET: "sla-integration-secret-0123456789-abcdef", APP_URL: ORIGIN, LOG_LEVEL: "error", NODE_ENV: "test" });
    (await import("@/lib/env")).resetEnvCache();
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await clean();
    for (const u of [cust, agent, root]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role})`;
    T = await import("@/app/api/tickets/route");
    TID = await import("@/app/api/tickets/[id]/route");
    slaDb = await import("@/lib/sla-db");
    dbMod = await import("@/lib/db");
  });
  afterAll(async () => {
    await clean();
    await sql.end();
  });
  beforeEach(async () => {
    as(null);
    await sql`delete from ticket where customer_id = ${cust.id}`;
  });

  async function queueOf(who: Who, query = ""): Promise<Json[]> {
    as(who);
    const res = await T.GET(req(`/api/tickets?limit=100${query}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as Json).tickets.filter((t: Json) => t.subject.startsWith("sla-"));
  }

  describe("the queue", () => {
    it("is sorted by what is ticking: soonest deadline first, paused work after, resolved last", async () => {
      // Created in a scrambled order on purpose.
      const resolved = await make("resolved", { status: "resolved", answeredH: -3, resolvedH: -2, firstDueH: 4, resDueH: 0.2 });
      const pausedAnswered = await make("paused-answered", { status: "pending_customer", answeredH: -5, pausedH: -4, firstDueH: 3, resDueH: 1 });
      const unansweredLate = await make("unanswered-5h", { status: "new", firstDueH: 5, resDueH: 60 });
      const answeredSoon = await make("answered-2h", { answeredH: -0.5, firstDueH: 6, resDueH: 2 });
      const pausedUnanswered = await make("paused-unanswered", { status: "pending_customer", pausedH: -0.1, firstDueH: 0.5, resDueH: 70 });
      const unansweredSoon = await make("unanswered-1h", { status: "new", firstDueH: 1, resDueH: 60 });

      const ids = (await queueOf(agent)).map((t) => t.id);
      expect(ids).toEqual([pausedUnanswered, unansweredSoon, answeredSoon, unansweredLate, pausedAnswered, resolved]);
    });

    it("an overdue ticket sorts ahead of everything still on time", async () => {
      const ok = await make("on-time", { status: "new", firstDueH: 3, resDueH: 60 });
      const late = await make("overdue", { status: "new", createdH: -9, firstDueH: -1, resDueH: 50 });
      expect((await queueOf(agent)).map((t) => t.id)).toEqual([late, ok]);
    });

    it("keeps the order stable across pages", async () => {
      const made: string[] = [];
      for (let i = 0; i < 5; i++) made.push(await make(`page-${i}`, { status: "new", firstDueH: 2 + i, resDueH: 60 }));
      as(agent);
      const all = ((await (await T.GET(req("/api/tickets?limit=100"))).json()) as Json).tickets.map((t: Json) => t.id);
      const first = (await (await T.GET(req("/api/tickets?limit=3"))).json()) as Json;
      expect(first.hasMore).toBe(true);
      const second = (await (await T.GET(req(`/api/tickets?limit=3&offset=${first.nextOffset}`))).json()) as Json;
      expect([...first.tickets, ...second.tickets].map((t: Json) => t.id)).toEqual(all.slice(0, first.tickets.length + second.tickets.length));
      expect(all.filter((id: string) => made.includes(id))).toEqual(made);
    });

    it("the Unassigned view keeps the same order", async () => {
      const b = await make("u-b", { status: "new", firstDueH: 4, resDueH: 60 });
      const a = await make("u-a", { status: "new", firstDueH: 2, resDueH: 60 });
      expect((await queueOf(agent, "&view=unassigned")).map((t) => t.id)).toEqual([a, b]);
    });
  });

  describe("state on every read", () => {
    it("agents get the computed SLA with each ticket, in the queue and on the ticket", async () => {
      const fresh = await make("fresh", { status: "new", createdH: -0.1, firstDueH: 7.9, resDueH: 71.9 });
      const risky = await make("risky", { status: "new", createdH: -7, firstDueH: 1, resDueH: 65 });
      const late = await make("late", { status: "new", createdH: -9, firstDueH: -1, resDueH: 63 });
      const paused = await make("paused", { status: "pending_customer", createdH: -50, answeredH: -45, pausedH: -2, firstDueH: -42, resDueH: -1 });
      const done = await make("done", { status: "resolved", answeredH: -3, resolvedH: -1, firstDueH: 4, resDueH: 60 });

      const byId = Object.fromEntries((await queueOf(agent)).map((t) => [t.id, t.sla]));
      expect(byId[fresh]).toMatchObject({ state: "ok", firstResponse: "ok", resolution: "ok" });
      expect(byId[risky]).toMatchObject({ state: "at_risk", firstResponse: "at_risk" });
      expect(byId[late]).toMatchObject({ state: "breached", firstResponse: "breached" });
      expect(byId[paused]).toMatchObject({ state: "paused", resolution: "paused", nextDueAt: null });
      expect(byId[done]).toMatchObject({ state: "met", firstResponse: "met", resolution: "met", nextDueAt: null });

      as(agent);
      const one = (await (await TID.GET(req(`/api/tickets/${late}`), ctx(late))).json()) as Json;
      expect(one.ticket.sla.state).toBe("breached");
    });

    it("customers never get the SLA, due times, breach facts or queue ordering fields", async () => {
      const id = await make("hidden", { status: "new", createdH: -9, firstDueH: -1, resDueH: 63 });
      as(cust);
      const list = await (await T.GET(req("/api/tickets"))).text();
      const one = await (await TID.GET(req(`/api/tickets/${id}`), ctx(id))).text();
      for (const text of [list, one]) {
        for (const secret of ["\"sla\"", "DueAt", "breach", "paused", "nextDue"]) expect(text).not.toContain(secret);
      }
    });

    it("an admin gets nothing about tickets, so no SLA either", async () => {
      await make("admin", { status: "new", firstDueH: 3, resDueH: 60 });
      as(root);
      expect((await T.GET(req("/api/tickets"))).status).toBe(404);
    });
  });

  describe("lazy breach stamping", () => {
    it("stamps each clock at its due time, once; running it again changes nothing", async () => {
      const firstLate = await make("fl", { status: "new", createdH: -9, firstDueH: -1, resDueH: 60 });
      const bothLate = await make("bl", { answeredH: -80, createdH: -100, firstDueH: -92, resDueH: -28 });
      const before = { a: await row(firstLate), b: await row(bothLate) };
      expect(before.a.breached_first_response_at).toBeNull();

      await slaDb.stampBreaches(dbMod.db());
      const once = { a: await row(firstLate), b: await row(bothLate) };
      expect(once.a.breached_first_response_at).toEqual(once.a.first_response_due_at); // the due time, not "when we looked"
      expect(once.a.breached_resolution_at).toBeNull();
      expect(once.b.breached_first_response_at).toBeNull(); // answered, on time
      expect(once.b.breached_resolution_at).toEqual(once.b.resolution_due_at);

      await new Promise((r) => setTimeout(r, 25));
      await slaDb.stampBreaches(dbMod.db());
      expect(await row(firstLate)).toEqual(once.a);
      expect(await row(bothLate)).toEqual(once.b);
    });

    it("leaves alone what isn't a breach: on-time, paused, answered, and resolved before the deadline", async () => {
      const onTime = await make("ontime", { status: "new", firstDueH: 3, resDueH: 60 });
      const paused = await make("paused", { status: "pending_customer", answeredH: -30, createdH: -50, pausedH: -20, firstDueH: -42, resDueH: -2 });
      const answered = await make("answered", { answeredH: -8, createdH: -9, firstDueH: -1, resDueH: 60 });
      const closedInTime = await make("closed", { status: "resolved", resolvedH: -5, createdH: -9, firstDueH: -1, resDueH: -1 + 0.5 });
      await slaDb.stampBreaches(dbMod.db());
      for (const id of [onTime, paused, answered, closedInTime]) {
        const t = await row(id);
        expect(t.breached_first_response_at, id).toBeNull();
        expect(t.breached_resolution_at, id).toBeNull();
      }
    });

    it("never moves a stamp that is already on record, whatever happens to the deadline afterwards", async () => {
      const id = await make("kept", { status: "new", createdH: -9, firstDueH: -1, resDueH: 60, breachedFirst: true });
      const stamped = (await row(id)).breached_first_response_at;
      await sql`update ticket set first_response_due_at = now() + interval '5 hours' where id = ${id}`;
      await slaDb.stampBreaches(dbMod.db());
      expect((await row(id)).breached_first_response_at).toEqual(stamped);
    });

    it("ten parallel reads stamp the same value and nothing else", async () => {
      const id = await make("race", { status: "new", createdH: -9, firstDueH: -1, resDueH: -0.5 });
      as(agent);
      const res = await Promise.all(Array.from({ length: 10 }, () => T.GET(req("/api/tickets?limit=100"))));
      expect(res.map((r) => r.status)).toEqual(Array(10).fill(200));
      const t = await row(id);
      expect(t.breached_first_response_at).toEqual(t.first_response_due_at);
      expect(t.breached_resolution_at).toEqual(t.resolution_due_at);
    });

    it("any read stamps: an agent's queue, a customer's ticket page and a customer's list all do", async () => {
      const a = await make("ra", { status: "new", createdH: -9, firstDueH: -1, resDueH: 60 });
      await queueOf(agent);
      expect((await row(a)).breached_first_response_at).not.toBeNull();

      const b = await make("rb", { status: "new", createdH: -9, firstDueH: -1, resDueH: 60 });
      as(cust);
      await TID.GET(req(`/api/tickets/${b}`), ctx(b));
      expect((await row(b)).breached_first_response_at).not.toBeNull();

      const c = await make("rc", { status: "new", createdH: -9, firstDueH: -1, resDueH: 60 });
      await T.GET(req("/api/tickets"));
      expect((await row(c)).breached_first_response_at).not.toBeNull();
    });
  });
});
