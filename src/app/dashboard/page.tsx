import { redirect } from "next/navigation";
import { homeFor, requireUserOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Where sign-in lands: each role goes to its own home (customers /support, agents /desk, admins /admin). */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  redirect(homeFor(user.role));
}
