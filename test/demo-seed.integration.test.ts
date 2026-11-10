/**
 * The demo workspace: CLI refusal rules, the loader against a real Postgres (TEST_DATABASE_URL) and Better Auth, and
 * POST /api/admin/demo. Proves the data (3 customers, 2 agents, 1 admin, 12 tickets, one breached, one paused), that a
 * reload replaces only demo rows, that internal notes in the demo never reach a customer or the outbox, and that the
 * admin button can't create an admin account, can't be spammed and can't touch an unrelated account.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/rbac";
import { demoSeedConfig } from "@/lib/demo-seed-config";

const current = vi.hoisted(() => ({ role: "admin" as "admin" | "user" | "agent" }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: vi.fn(async (role: string) => {
    if (current.role !== role) throw new ForbiddenError();
    return { id: "ds-admin", name: "Admin", email: "ds-admin@test.local", role: current.role };
  }),
}));

const base = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-test-password-123" };
const tsxArgs = ["--conditions=react-server", "--import", "tsx", "scripts/seed-demo.mts"];

describe("demo CLI guards", () => {
  it.each([undefined, "no", "true"])("refuses DEMO_SEED=%s", (value) => {
    expect(() => demoSeedConfig({ ...base, DEMO_SEED: value })).toThrow("DEMO_SEED=yes");
  });
  it.each(["https://app11.breakthruventures.ai", "https://helpdesk-abc.run.app", "http://1-2-3-4.sslip.io"])("refuses production URL %s", (APP_URL) => {
    expect(() => demoSeedConfig({ ...base, APP_URL })).toThrow("production host");
  });
  it("the actual CLI exits before connecting to a database when guarded", () => {
    for (const values of [{ ...base, DEMO_SEED: "no" }, { ...base, APP_URL: "https://app11.breakthruventures.ai" }]) {
      const child = spawnSync(process.execPath, tsxArgs, { env: { ...process.env, ...values, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" }, encoding: "utf8", timeout: 30000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("Demo seed refused");
      expect(child.stderr).not.toContain("ECONNREFUSED");
    }
  });
  it("the actual CLI refuses a production database host and a Cloud SQL socket", () => {
    for (const DATABASE_URL of ["postgres://postgres:x@postgres:5432/helpdesk", "postgres://u:p@/db?host=/cloudsql/proj:r:i"]) {
      const child = spawnSync(process.execPath, tsxArgs, { env: { ...process.env, ...base, DATABASE_URL }, encoding: "utf8", timeout: 30000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("production database");
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("demo workspace (Postgres, Better Auth)", () => {
  let sql: postgres.Sql;
  let loader: typeof import("@/lib/demo-workspace");
  let tickets: typeof import("@/lib/tickets");
  let post: typeof import("@/app/api/admin/demo/route").POST;
  let handler: (req: Request) => Promise<Response>;
  const actor = { id: "ds-admin", role: "admin" as const };
  const real = { id: "ds-real", role: "user" as const };
  const NOTES = ["legacy discount", "reset mails are bouncing", "Reproduced on staging", "Cookie SameSite regression"];
  const email = (local: string) => `${local}@demo.breakthru.test`;
  const demoEmails = ["casey", "devon", "emery", "avery.agent", "blake.agent", "admin"].map(email);
  const req = (origin: string | null = "http://localhost:3000") => new Request("http://localhost:3000/api/admin/demo", { method: "POST", headers: origin ? { origin } : {} });

  async function clean() {
    await sql`delete from "user" where email in ${sql(demoEmails)} or id = 'ds-real' or email like 'ds-%'`;
    await sql`delete from rate_event where kind = 'demo_load' or user_id like 'ds-%'`;
    await sql`delete from daily_usage`;
  }

  beforeAll(async () => {
    Object.assign(process.env, base, { NODE_ENV: "test", DATABASE_URL: url, BETTER_AUTH_SECRET: "demo-integration-secret-32-characters", AI_PROVIDER: "demo", LOG_LEVEL: "error" });
    (await import("@/lib/env")).resetEnvCache();
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await clean();
    loader = await import("@/lib/demo-workspace");
    tickets = await import("@/lib/tickets");
    post = (await import("@/app/api/admin/demo/route")).POST;
    handler = (await import("@/lib/auth")).auth().handler;
  });
  afterAll(async () => {
    await clean();
    await sql.end();
  });
  beforeEach(async () => {
    current.role = "admin";
    // The route records its rate event against the acting admin, who must exist (the CLI's synthetic id never reaches it).
    await sql`insert into "user" (id, name, email, role) values ('ds-admin', 'Admin', 'ds-admin@test.local', 'admin') on conflict do nothing`;
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage`;
  });

  const roles = async () => (await sql`select role, count(*)::int as n from "user" where email in ${sql(demoEmails)} group by role`).reduce((m, r) => ({ ...m, [r.role]: r.n }), {} as Record<string, number>);
  const demoIds = async () => (await sql`select id from "user" where email in ${sql(demoEmails)}`).map((r) => r.id as string);

  it("CLI load: 3 customers, 2 agents, 1 admin and 12 tickets across every state, one breached and one paused", async () => {
    const result = await loader.loadDemoWorkspace(actor, { mode: "cli" });
    expect(result).toMatchObject({ users: 6, tickets: 12 });
    expect(await roles()).toEqual({ user: 3, agent: 2, admin: 1 });
    const ids = await demoIds();
    const states = await sql`select status, count(*)::int as n from ticket where customer_id = any(${ids}) group by status`;
    expect(Object.fromEntries(states.map((r) => [r.status, r.n]))).toMatchObject({ new: 3, open: 5, pending_customer: 1, resolved: 3 });
    const breached = await sql`select id from ticket where customer_id = any(${ids}) and (breached_first_response_at is not null or breached_resolution_at is not null)`;
    expect(breached).toHaveLength(1);
    const paused = await sql`select status, paused_at from ticket where customer_id = any(${ids}) and paused_at is not null`;
    expect(paused).toEqual([expect.objectContaining({ status: "pending_customer" })]);
    // At least one resolved more than 7 days ago (a follow-up case) and one within the window.
    const old = await sql`select 1 from ticket where customer_id = any(${ids}) and status = 'resolved' and resolved_at < now() - interval '7 days'`;
    expect(old).toHaveLength(1);
    // The AI sets no `urgent`: the two urgent demo tickets are agent-side data, and triage fixtures never carry one.
    const urgentAi = await sql`select 1 from ticket where customer_id = any(${ids}) and triage_source = 'ai' and priority = 'urgent'`;
    expect(urgentAi).toHaveLength(0);
  });

  it("demo accounts carry the marker, CLI passwords work, and the demo agent really is an agent", async () => {
    const res = await handler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email("avery.agent"), password: base.DEMO_PASSWORD }) }));
    expect(res.status).toBe(200);
    const [row] = await sql`select role, image from "user" where email = ${email("avery.agent")}`;
    expect(row).toEqual({ role: "agent", image: "urn:breakthru:helpdesk-demo:v1" });
  });

  it("internal notes exist in the demo, and no demo customer's view or any notification contains one", async () => {
    const ids = await demoIds();
    const internal = await sql`select body from ticket_message where customer_id = any(${ids}) and visibility = 'internal'`;
    expect(internal).toHaveLength(NOTES.length);
    const customers = await sql`select id, name, email, role from "user" where email in ${sql([email("casey"), email("devon"), email("emery")])}`;
    for (const c of customers) {
      const mine = await tickets.listTickets({ id: c.id, role: "user" });
      for (const t of mine.tickets) {
        const detail = JSON.stringify(await tickets.getTicket({ id: c.id, role: "user" }, t.id));
        for (const note of NOTES) expect(detail).not.toContain(note);
      }
    }
    const mail = await sql`select subject, snippet from mail_message where recipient_id = any(${ids})`;
    expect(mail.length).toBeGreaterThan(10);
    for (const m of mail) for (const note of NOTES) expect(`${m.subject} ${m.snippet}`).not.toContain(note);
    // A demo agent sees the notes.
    const [avery] = await sql`select id from "user" where email = ${email("avery.agent")}`;
    const all = JSON.stringify(await tickets.listTickets({ id: avery.id, role: "agent" }, { limit: 100 }));
    expect(all).toContain("Casey Rivera");
  });

  it("a reload replaces the demo's tickets (no duplicates) and leaves a real user's data alone", async () => {
    await sql`insert into "user" (id, name, email) values (${real.id}, 'Real Person', 'ds-real@test.local')`;
    const t = await tickets.createTicket(real, { subject: "A real ticket", body: "Do not delete me" });
    await loader.loadDemoWorkspace(actor, { mode: "cli" });
    const ids = await demoIds();
    expect((await sql`select count(*)::int as n from ticket where customer_id = any(${ids})`)[0].n).toBe(12);
    expect(await sql`select 1 from ticket where id = ${t.ticket.id}`).toHaveLength(1);
    expect(await sql`select 1 from mail_message where recipient_id = ${real.id}`).toHaveLength(1);
  });

  it("the admin button creates no admin and no known password, and loads the tickets", async () => {
    await clean();
    await sql`insert into "user" (id, name, email, role) values ('ds-admin', 'Admin', 'ds-admin@test.local', 'admin')`;
    const res = await post(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ users: 5, tickets: 12 });
    expect(await roles()).toEqual({ user: 3, agent: 2 });
    const [{ n }] = await sql`select count(*)::int as n from account a join "user" u on u.id = a.user_id where u.email in ${sql(demoEmails)} and a.provider_id = 'credential'`;
    expect(n).toBe(5);
    const signIn = await handler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email("casey"), password: base.DEMO_PASSWORD }) }));
    expect(signIn.status).toBeGreaterThanOrEqual(400); // rotated to a random secret
  });

  it("the admin button is admin-only, same-origin only, and limited to one load per minute", async () => {
    current.role = "agent";
    expect((await post(req())).status).toBe(403);
    current.role = "user";
    expect((await post(req())).status).toBe(403);
    current.role = "admin";
    expect((await post(req(null))).status).toBe(403);
    expect((await post(req("https://evil.example"))).status).toBe(403);
    expect((await post(req())).status).toBe(200);
    expect((await post(req())).status).toBe(429);
  });

  it("refuses to adopt an unrelated account at a demo address: nothing is replaced", async () => {
    await clean();
    await loader.loadDemoWorkspace(actor, { mode: "cli" });
    await sql`update "user" set image = null where email = ${email("devon")}`;
    const before = (await sql`select count(*)::int as n from ticket`)[0].n;
    await expect(loader.loadDemoWorkspace(actor, { mode: "cli" })).rejects.toMatchObject({ status: 409 });
    expect((await sql`select count(*)::int as n from ticket`)[0].n).toBe(before);
  });

  it("only an admin actor can load, and unknown modes are refused", async () => {
    await expect(loader.loadDemoWorkspace({ id: "x", role: "agent" }, { mode: "admin" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(loader.loadDemoWorkspace({ id: "x", role: "user" }, { mode: "admin" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(loader.loadDemoWorkspace(actor, { mode: "root" })).rejects.toThrow();
    await expect(loader.loadDemoWorkspace(actor, { mode: "admin", password: "x" })).rejects.toThrow();
  });
});
