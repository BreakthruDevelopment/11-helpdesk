/**
 * The `agent` role, through Better Auth's admin plugin against a real Postgres (TEST_DATABASE_URL):
 * sign-up can't choose a role, only an admin grants `agent` (audited as `role.changed`), unknown roles and role
 * lists are refused, agents get no admin-plugin powers, and `requireRole` is exact (admin is not an agent).
 * Better Auth's origin check is off under NODE_ENV=test, so requests need no Origin header.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";

const cookieJar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(cookieJar.cookie ? { cookie: cookieJar.cookie } : {}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

describe.skipIf(!url)("agent role (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let session: typeof import("@/lib/auth/session");
  let logSpy: ReturnType<typeof vi.spyOn>;
  let adminCookie: string;
  let agentCookie: string;
  let plainCookie: string;
  let plainId: string;
  let agentId: string;
  const email = (n: string) => `rl-${n}@test.local`;

  async function call(path: string, body: unknown, cookie?: string) {
    return handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }
  async function signUp(name: string, extra: Record<string, unknown> = {}) {
    const res = await call("/sign-up/email", { name, email: email(name), password: PASSWORD, ...extra });
    return { res, id: res.status === 200 ? ((await res.json()) as { user: { id: string } }).user.id : null };
  }
  async function signIn(name: string) {
    const res = await call("/sign-in/email", { email: email(name), password: PASSWORD });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const roleOf = async (id: string) => (await sql`select role from "user" where id = ${id}`)[0].role as string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where email like 'rl-%@test.local'`;
    const { auth } = await import("@/lib/auth");
    handler = auth().handler;
    session = await import("@/lib/auth/session");
    const { log } = await import("@/lib/log");
    logSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const adminId = (await signUp("admin")).id!;
    plainId = (await signUp("plain")).id!;
    agentId = (await signUp("agent")).id!;
    await sql`update "user" set role = 'admin' where id = ${adminId}`;
    await sql`update "user" set role = 'agent' where id = ${agentId}`;
    adminCookie = await signIn("admin");
    agentCookie = await signIn("agent");
    plainCookie = await signIn("plain");
  });
  afterAll(async () => {
    logSpy.mockRestore();
    await sql`delete from "user" where email like 'rl-%@test.local'`;
    await sql.end();
  });
  beforeEach(() => {
    logSpy.mockClear();
    cookieJar.cookie = "";
  });

  it("sign-up stays a customer even when the body says role: agent or admin", async () => {
    for (const [i, role] of (["agent", "admin", ["admin"]] as const).entries()) {
      const { res, id } = await signUp(`sneaky${i}`, { role });
      // Better Auth either ignores the field or refuses the request; either way no account gets the role.
      if (res.status === 200) expect(await roleOf(id!)).toBe("user");
      else expect(await sql`select 1 from "user" where email = ${email(`sneaky${i}`)}`).toHaveLength(0);
    }
  });

  it("sign-up can't smuggle a role through data either", async () => {
    const { id } = await signUp("sneaky-data", { data: { role: "admin" }, additionalFields: { role: "admin" } });
    if (id) expect(await roleOf(id)).toBe("user");
  });

  it("a customer or an agent can't change anyone's role", async () => {
    for (const cookie of [plainCookie, agentCookie]) {
      const res = await call("/admin/set-role", { userId: plainId, role: "agent" }, cookie);
      expect(res.status).toBe(403);
    }
    expect(await roleOf(plainId)).toBe("user");
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("only an admin grants agent, and the grant is logged as role.changed with who, whom and what", async () => {
    const { id } = await signUp("grantee");
    const res = await call("/admin/set-role", { userId: id, role: "agent" }, adminCookie);
    expect(res.status).toBe(200);
    expect(await roleOf(id!)).toBe("agent");
    const adminId = (await sql`select id from "user" where email = ${email("admin")}`)[0].id;
    expect(logSpy).toHaveBeenCalledWith("role.changed", { by: adminId, userId: id, role: "agent" });
    // And back down again.
    expect((await call("/admin/set-role", { userId: id, role: "user" }, adminCookie)).status).toBe(200);
    expect(await roleOf(id!)).toBe("user");
  });

  it("refuses an unknown role name and logs nothing", async () => {
    for (const role of ["underwriter", "superuser", "admin,agent", ""]) {
      const res = await call("/admin/set-role", { userId: plainId, role }, adminCookie);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await roleOf(plainId)).toBe("user");
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("refuses a role list, so one account never holds two roles (set-role, update-user, create-user)", async () => {
    let res = await call("/admin/set-role", { userId: plainId, role: ["admin", "agent"] }, adminCookie);
    expect(res.status).toBe(400);
    res = await call("/admin/update-user", { userId: plainId, data: { role: ["agent", "user"] } }, adminCookie);
    expect(res.status).toBe(400);
    res = await call("/admin/create-user", { email: email("listed"), name: "L", password: PASSWORD, role: ["agent", "admin"] }, adminCookie);
    expect(res.status).toBe(400);
    expect(await sql`select 1 from "user" where email = ${email("listed")}`).toHaveLength(0);
    expect(await roleOf(plainId)).toBe("user");
  });

  it("an admin can still create an agent directly, and update-user can set a single valid role", async () => {
    const res = await call("/admin/create-user", { email: email("made"), name: "M", password: PASSWORD, role: "agent" }, adminCookie);
    expect(res.status).toBe(200);
    expect(await roleOf(((await res.json()) as { user: { id: string } }).user.id)).toBe("agent");
    expect((await call("/admin/update-user", { userId: plainId, data: { name: "Plain Person" } }, adminCookie)).status).toBe(200);
  });

  it("agents hold no admin-plugin permission at all", async () => {
    for (const [path, body] of [
      ["/admin/has-permission", { permissions: { user: ["set-role"] } }],
      ["/admin/has-permission", { permissions: { user: ["list"] } }],
      ["/admin/has-permission", { permissions: { user: ["ban"] } }],
      ["/admin/has-permission", { permissions: { session: ["revoke"] } }],
    ] as const) {
      const res = await call(path, body, agentCookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { success: boolean }).success).toBe(false);
    }
    for (const path of ["/admin/ban-user", "/admin/remove-user", "/admin/set-role"]) {
      expect((await call(path, { userId: plainId, role: "agent" }, agentCookie)).status).toBe(403);
    }
    const list = await handler(new Request("http://localhost:3000/api/auth/admin/list-users", { headers: { cookie: agentCookie } }));
    expect(list.status).toBe(403);
  });

  it("the signed-in user's role is read as exactly one of user, agent, admin", async () => {
    cookieJar.cookie = plainCookie;
    expect((await session.requireUser()).role).toBe("user");
    cookieJar.cookie = agentCookie;
    expect((await session.requireUser()).role).toBe("agent");
    cookieJar.cookie = adminCookie;
    expect((await session.requireUser()).role).toBe("admin");
  });

  it("requireRole is exact: admin is not an agent, an agent is not an admin, a customer is neither", async () => {
    const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
    cookieJar.cookie = agentCookie;
    await expect(session.requireRole("agent")).resolves.toMatchObject({ role: "agent" });
    await expect(session.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = adminCookie;
    await expect(session.requireRole("admin")).resolves.toMatchObject({ role: "admin" });
    await expect(session.requireRole("agent")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = plainCookie;
    await expect(session.requireRole("agent")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(session.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = "";
    await expect(session.requireRole("agent")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("pages send a signed-in user without the role to their own home", async () => {
    cookieJar.cookie = plainCookie;
    await expect(session.requireRoleOrRedirect("agent")).rejects.toThrow("REDIRECT:/dashboard");
    cookieJar.cookie = adminCookie;
    await expect(session.requireRoleOrRedirect("agent")).rejects.toThrow("REDIRECT:/admin");
    cookieJar.cookie = agentCookie;
    await expect(session.requireRoleOrRedirect("admin")).rejects.toThrow("REDIRECT:/dashboard");
    await expect(session.requireRoleOrRedirect("agent")).resolves.toMatchObject({ role: "agent" });
    cookieJar.cookie = "";
    await expect(session.requireUserOrRedirect()).rejects.toThrow("REDIRECT:/sign-in");
  });

  it("a banned agent is signed out (no role, no session)", async () => {
    const { id } = await signUp("banned-agent");
    await sql`update "user" set role = 'agent' where id = ${id}`;
    const cookie = await signIn("banned-agent");
    cookieJar.cookie = cookie;
    await expect(session.requireRole("agent")).resolves.toBeTruthy();
    await sql`update "user" set banned = true where id = ${id}`;
    await expect(session.requireRole("agent")).rejects.toThrow();
  });

  it("public sign-up can't take a demo address or the demo marker", async () => {
    const res = await call("/sign-up/email", { name: "Fake", email: "casey@demo.breakthru.test", password: PASSWORD });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await sql`select 1 from "user" where email = 'casey@demo.breakthru.test' and image is not null`).toHaveLength(0);
    const res2 = await call("/sign-up/email", { name: "Fake", email: email("marker"), password: PASSWORD, image: "urn:breakthru:helpdesk-demo:v1" });
    expect(res2.status).toBeGreaterThanOrEqual(400);
  });
});
