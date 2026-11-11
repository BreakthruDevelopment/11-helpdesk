import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./index";
import { type Actor, type Role, ForbiddenError, UnauthorizedError, toRole } from "./rbac";

export type CurrentUser = Actor & { name: string; email: string };

/**
 * The data access layer's single entry point for "who is this?".
 * Returns a narrow user object, never the raw session.
 * Wrapped in React cache(), so the shell and the page share one lookup per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const result = await auth().api.getSession({ headers: await headers() });
  if (!result?.user) return null;
  const u = result.user as typeof result.user & { role?: string | null; banned?: boolean | null };
  if (u.banned) return null;
  return { id: u.id, name: u.name, email: u.email, role: toRole(u.role) };
});

/** For pages: send signed-out visitors to the sign-in page. */
export async function requireUserOrRedirect(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** For pages: signed-in users without exactly this role go to their own home. Admin is not a superset of agent. */
export async function requireRoleOrRedirect(role: Role): Promise<CurrentUser> {
  const user = await requireUserOrRedirect();
  if (user.role !== role) redirect(homeFor(user.role));
  return user;
}

/**
 * Where each role lands after sign-in and when it asks for a page that isn't its own.
 * Customers go to the portal. Agents stay on /dashboard until the desk exists (issue 11.5). Admins keep /admin.
 */
export function homeFor(role: Role): string {
  if (role === "admin") return "/admin";
  if (role === "user") return "/support";
  return "/dashboard";
}

/** For route handlers and server actions: throw, so the caller maps it to 401/403. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Exactly this role (403 otherwise). Admin does not pass `requireRole("agent")`, or the other way round. */
export async function requireRole(role: Role): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== role) throw new ForbiddenError();
  return user;
}
