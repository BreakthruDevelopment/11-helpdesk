import type { Metadata } from "next";
import { headers } from "next/headers";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { adminStats } from "@/lib/admin-stats";
import { auth } from "@/lib/auth";
import { toRole, type Role } from "@/lib/auth/rbac";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { STATUS_LABEL } from "@/lib/desk-view";
import { AgentRoleButton, DemoButton } from "./admin-controls";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<Role, string> = { user: "Customer", agent: "Agent", admin: "Admin" };

/**
 * Counts only: tickets by status, SLA breaches, AI calls against the daily cap, accounts by role. Never a subject,
 * message or ticket id (admins get 404 from every content function). Granting `agent` goes through Better Auth's
 * admin endpoint, which logs every role change.
 */
export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const [stats, list] = await Promise.all([
    adminStats(admin),
    auth().api.listUsers({ query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" }, headers: await headers() }),
  ]);
  const users = list.users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: toRole((u as { role?: string | null }).role),
    createdAt: new Date(u.createdAt),
  }));
  const aiShare = stats.ai.dailyCap > 0 ? Math.round((stats.ai.callsToday / stats.ai.dailyCap) * 100) : 0;

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => <span className="font-semibold break-words">{u.name}</span> },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) =>
        u.role === "admin" ? (
          <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span>
        ) : (
          ROLE_LABEL[u.role]
        ),
    },
    { key: "joined", header: "Joined", className: "whitespace-nowrap", cell: (u) => u.createdAt.toISOString().slice(0, 10) },
    {
      key: "actions",
      header: "Change role",
      srOnlyHeader: true,
      hideLabel: true,
      cell: (u) =>
        u.role === "admin" || u.id === admin.id ? <span className="text-sm text-muted">Admin accounts are managed separately</span> : <AgentRoleButton userId={u.id} name={u.name} role={u.role} />,
    },
  ];

  return (
    <>
      <PageIntro section="Admin" title="Helpdesk overview" description="Counts and accounts only. Admins never see ticket contents." />

      <h2 className="mb-3 font-display text-2xl font-semibold">Tickets</h2>
      <StatGrid>
        <StatTile value={stats.tickets.total} label="All tickets" tone="accent" />
        <StatTile value={stats.tickets.new} label={STATUS_LABEL.new} />
        <StatTile value={stats.tickets.open} label={STATUS_LABEL.open} />
        <StatTile value={stats.tickets.pending_customer} label={STATUS_LABEL.pending_customer} />
        <StatTile value={stats.tickets.resolved} label={STATUS_LABEL.resolved} tone="live" />
      </StatGrid>

      <h2 className="mb-3 mt-8 font-display text-2xl font-semibold">SLA and AI</h2>
      <StatGrid>
        <StatTile value={stats.slaBreaches.firstResponse} label="First-response breaches" tone={stats.slaBreaches.firstResponse > 0 ? "blocked" : "default"} />
        <StatTile value={stats.slaBreaches.resolution} label="Resolution breaches" tone={stats.slaBreaches.resolution > 0 ? "blocked" : "default"} />
        <StatTile value={`${stats.ai.callsToday} / ${stats.ai.dailyCap}`} label={`AI calls today vs daily cap (${aiShare}%)`} tone={aiShare >= 80 ? "building" : "default"} />
      </StatGrid>

      <h2 className="mb-3 mt-8 font-display text-2xl font-semibold">Accounts</h2>
      <StatGrid>
        <StatTile value={stats.users.customers} label="Customers" />
        <StatTile value={stats.users.agents} label="Agents" tone="accent" />
        <StatTile value={stats.users.admins} label="Admins" />
      </StatGrid>

      <div className="mt-8 space-y-6">
        <Panel title="Users" count={users.length}>
          <p className="mb-4 text-sm text-muted">Make a customer an agent to give them the desk and the knowledge-base editor. Newest 100 accounts.</p>
          <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
        </Panel>
        <Panel title="Demo workspace">
          <DemoButton />
        </Panel>
      </div>
    </>
  );
}
