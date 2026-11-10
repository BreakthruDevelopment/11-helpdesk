import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { isDemoEmail, MARKER } from "@/lib/demo-identity";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { ac, DISABLED_AUTH_PATHS, roles } from "./permissions";

/**
 * Demo identities are created only by the server-side loader (no HTTP request in the endpoint context). Any
 * request-driven create or update, such as public sign-up or update-user, cannot use a demo address or the marker.
 */
function rejectDemoIdentity(data: Record<string, unknown>, ctx: { request?: Request } | null | undefined) {
  if (!ctx?.request) return;
  if (isDemoEmail(data.email) || data.image === MARKER) {
    throw new APIError("BAD_REQUEST", { message: "That email or image is reserved." });
  }
}

/** The admin-plugin paths that write a role. */
const ROLE_WRITE_PATHS = new Set(["/admin/set-role", "/admin/create-user", "/admin/update-user"]);

/** Role values in a request body, wherever the admin plugin accepts them. */
function requestedRoles(body: Record<string, unknown> | undefined): unknown[] {
  const data = body?.data as Record<string, unknown> | undefined;
  return [body?.role, data?.role].filter((v) => v !== undefined);
}

/**
 * Better Auth accepts `role: ["admin", "agent"]` and stores "admin,agent". One account holds exactly one role here
 * (toRole() returns one), so a list is refused before it reaches the plugin. Unknown role names are refused by the
 * plugin itself, because the `roles` map below is the allow-list. Only an admin may call these paths at all.
 */
const roleGuard = createAuthMiddleware(async (ctx) => {
  if (!ROLE_WRITE_PATHS.has(ctx.path)) return;
  for (const role of requestedRoles(ctx.body as Record<string, unknown> | undefined)) {
    if (typeof role !== "string") throw new APIError("BAD_REQUEST", { message: "A role must be a single name." });
  }
});

/** Audit trail for role grants: who changed whose role to what. Fires only when the change succeeded. */
const roleAudit = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/admin/set-role" || isAPIError(ctx.context.returned)) return;
  const body = ctx.body as { userId?: unknown; role?: unknown } | undefined;
  const session = await getSessionFromCtx(ctx).catch(() => null);
  log.info("role.changed", { by: session?.user.id ?? null, userId: body?.userId, role: body?.role });
});

function createAuth() {
  const e = env();
  return betterAuth({
    appName: e.APP_NAME,
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
    },
    // OIDC providers (Google, Microsoft Entra ID, GitHub, Okta via genericOAuth)
    // plug in here per app; they read their client IDs from env.
    socialProviders: {},
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: e.APP_URL.startsWith("https://"),
    },
    // Admins manage roles, bans and accounts but cannot impersonate or reset passwords
    // (see permissions.ts). The paths are also blocked outright, as a second layer.
    disabledPaths: DISABLED_AUTH_PATHS,
    hooks: { before: roleGuard, after: roleAudit },
    databaseHooks: {
      user: {
        create: { before: async (user, ctx) => void rejectDemoIdentity(user, ctx) },
        update: { before: async (data, ctx) => void rejectDemoIdentity(data, ctx) },
      },
    },
    plugins: [
      admin({ ac, roles, defaultRole: "user", adminRoles: ["admin"] }),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazily built so `next build` doesn't need a database or secrets. */
export function auth(): Auth {
  if (!instance) instance = createAuth();
  return instance;
}
