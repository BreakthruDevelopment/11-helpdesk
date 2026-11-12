import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatWhen } from "@/components/format-when";
import { DemoBadge, PageIntro, Panel, StatusBadge, buttonOutlineAccent, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/lib/db/schema";
import { CATEGORY_LABEL, NEXT_STATUSES, PRIORITY_LABEL, SLA_LABEL, SLA_TONE, STATUS_LABEL, triageDiff, type SlaState } from "@/lib/desk-view";
import { NotFoundError } from "@/lib/errors";
import { getLatestSuggestion, getTriage } from "@/lib/support-ai";
import { LIMITS, getTicket, type AgentMessage, type AgentTicket } from "@/lib/tickets";
import { requestRetriage, requestSuggestion, sendMessage, updateProperty } from "../actions";
import { DeskStatus, NeedsHuman, SlaChip, Tag } from "../badges";
import { Countdown } from "../countdown";
import { AutoRefresh } from "./auto-refresh";
import { Composer } from "./composer";
import { ComposerProvider } from "./composer-context";
import { PropertyForm, QuickChange } from "./property-form";
import { AddArticleLink, RetriageButton } from "./triage-card";

export const metadata: Metadata = { title: "Ticket" };
export const dynamic = "force-dynamic";

const SENTIMENT: Record<string, string> = { calm: "Calm", frustrated: "Frustrated", angry: "Angry" };

/**
 * One ticket for an agent: the thread with internal notes styled apart, the reply box (pinned on phones), properties,
 * SLA clocks and the triage card. All text is rendered as plain text by React; nothing here is HTML.
 */
export default async function DeskTicketPage({ params }: PageProps<"/desk/[id]">) {
  const agent = await requireRoleOrRedirect("agent");
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getTicket>>;
  let triage: Awaited<ReturnType<typeof getTriage>>;
  let latest: Awaited<ReturnType<typeof getLatestSuggestion>>;
  try {
    [detail, triage, latest] = await Promise.all([getTicket(agent, id), getTriage(agent, id), getLatestSuggestion(agent, id)]);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (!("sla" in detail.ticket)) notFound();
  const ticket: AgentTicket = detail.ticket;
  const messages = detail.messages.filter((m): m is AgentMessage => "visibility" in m);

  const update = updateProperty.bind(null, ticket.id);
  const statusOptions = [ticket.status, ...NEXT_STATUSES[ticket.status]].map((s) => ({ value: s, label: STATUS_LABEL[s] }));
  const diff = triage ? triageDiff(ticket, triage) : null;
  const setByAi = ticket.triageSource === "ai";

  return (
    <ComposerProvider>
      <AutoRefresh />
      <PageIntro
        section="Desk"
        title={ticket.subject}
        description={`#${ticket.number} · ${ticket.customerName ?? "Customer"} · opened ${formatWhen(ticket.createdAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DeskStatus status={ticket.status} />
            <SlaChip state={ticket.sla.state} />
            <Link href="/desk" className={buttonSecondary}>
              Back to queue
            </Link>
          </div>
        }
      />

      <div className="contents lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="min-w-0 space-y-6 max-lg:mb-6 lg:col-start-1">
          <Panel title="Conversation" count={messages.length}>
            {messages.length === 0 ? (
              <p className="text-muted">No messages on this ticket yet.</p>
            ) : (
              <ol className="space-y-3">
                {messages.map((m) => (
                  <Message key={m.id} m={m} me={agent.id} />
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <aside aria-label="Ticket details" className="min-w-0 space-y-6 max-lg:mb-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <Panel title="Properties">
            <div className="space-y-4">
              <PropertyForm action={update} field="status" label="Status" version={ticket.version} value={ticket.status} options={statusOptions} />
              <PropertyForm
                action={update}
                field="priority"
                label={setByAi ? "Priority (set by AI)" : "Priority"}
                version={ticket.version}
                value={ticket.priority}
                options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              />
              <PropertyForm
                action={update}
                field="category"
                label={setByAi ? "Category (set by AI)" : "Category"}
                version={ticket.version}
                value={ticket.category}
                options={TICKET_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
              />
              <div className="space-y-2">
                <p className="text-sm font-medium">Assignee</p>
                <p>{ticket.assigneeId === null ? <span className="text-muted">Unassigned</span> : ticket.assigneeId === agent.id ? "You" : "Another agent"}</p>
                <div className="flex flex-wrap gap-2">
                  {ticket.assigneeId !== agent.id && (
                    <QuickChange action={update} field="assignee" value="me" version={ticket.version}>
                      Assign to me
                    </QuickChange>
                  )}
                  {ticket.assigneeId !== null && (
                    <QuickChange action={update} field="assignee" value="none" version={ticket.version}>
                      Unassign
                    </QuickChange>
                  )}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="SLA">
            <dl className="space-y-3 text-sm">
              <Clock label="First response" state={ticket.sla.firstResponse} due={ticket.firstResponseDueAt} done={ticket.firstRespondedAt} />
              <Clock label="Resolution" state={ticket.sla.resolution} due={ticket.resolutionDueAt} done={ticket.resolvedAt} />
              <div>
                <dt className="font-medium">Next deadline</dt>
                <dd>
                  <Countdown due={ticket.sla.nextDueAt ? ticket.sla.nextDueAt.toISOString() : null} />
                </dd>
              </div>
              {ticket.pausedAt && <p className="text-muted">Paused while waiting on the customer since {formatWhen(ticket.pausedAt)}.</p>}
            </dl>
          </Panel>

          <Panel title="AI triage" action={triage?.demo ? <DemoBadge label="Demo AI" /> : setByAi ? <StatusBadge status="building" label="Set by AI" /> : undefined}>
            {triage === null ? (
              <div className="space-y-3">
                <p className="text-muted">No triage yet. It runs when a ticket is opened.</p>
                <RetriageButton action={requestRetriage.bind(null, ticket.id)} left={3} />
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <p className="text-muted">Suggestions only. Nothing here changes the ticket until you apply it.</p>
                <p className="whitespace-pre-wrap break-words text-base">{triage.summary}</p>
                <dl className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="font-medium">Category</dt>
                    <dd>
                      <Tag>{CATEGORY_LABEL[triage.category]}</Tag>
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Priority</dt>
                    <dd>
                      <Tag>{PRIORITY_LABEL[triage.priority]}</Tag>
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Sentiment</dt>
                    <dd>{SENTIMENT[triage.sentiment] ?? triage.sentiment}</dd>
                  </div>
                </dl>
                {triage.needsHumanBecause && <NeedsHuman reason={triage.needsHumanBecause} />}
                {diff && (diff.category || diff.priority) ? (
                  <div className="flex flex-wrap gap-2">
                    {diff.category && (
                      <QuickChange action={update} field="category" value={diff.category} version={ticket.version} className={buttonOutlineAccent}>
                        Apply category: {CATEGORY_LABEL[diff.category]}
                      </QuickChange>
                    )}
                    {diff.priority && (
                      <QuickChange action={update} field="priority" value={diff.priority} version={ticket.version} className={buttonOutlineAccent}>
                        Apply priority: {PRIORITY_LABEL[diff.priority]}
                      </QuickChange>
                    )}
                  </div>
                ) : (
                  <p className="text-muted">The ticket already has the suggested category and priority.</p>
                )}
                <div className="space-y-2">
                  <p className="font-medium">Suggested help articles</p>
                  {triage.articles.length === 0 ? (
                    <p className="text-muted">No published article matched.</p>
                  ) : (
                    <ul className="space-y-2">
                      {triage.articles.map((a) => (
                        <li key={a.id}>
                          <AddArticleLink article={a} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {/* Seeded or older triage rows can carry no time ("" from the data layer): show nothing then. */}
                {triage.at && !Number.isNaN(Date.parse(triage.at)) && <p className="text-muted">Triaged {formatWhen(triage.at)}.</p>}
                <RetriageButton action={requestRetriage.bind(null, ticket.id)} left={triage.retriagesLeft} />
              </div>
            )}
          </Panel>
        </aside>

        {/* Pinned to the bottom of the screen below 1024px (the grid above is display: contents there, so the page is the sticky range); in the left column under the thread on desktop. */}
        <div className="min-w-0 max-lg:sticky max-lg:bottom-0 max-lg:z-10 lg:col-start-1">
          <Composer
            send={sendMessage.bind(null, ticket.id)}
            suggest={requestSuggestion.bind(null, ticket.id)}
            latest={latest}
            bodyMax={LIMITS.bodyMax}
            reopens={ticket.status === "resolved"}
          />
        </div>
      </div>
    </ComposerProvider>
  );
}

function Message({ m, me }: { m: AgentMessage; me: string }) {
  const internal = m.visibility === "internal";
  const who = m.authorRole === "customer" ? (m.authorName ?? "Customer") : m.authorId === me ? "You" : (m.authorName ?? "Agent");
  const tone = internal
    ? "border-2 border-dashed border-building bg-building-soft"
    : m.authorRole === "agent"
      ? "border border-border border-l-4 border-l-accent bg-surface"
      : "border border-border bg-background";
  return (
    <li className={`min-w-0 rounded-card p-3 ${tone}`}>
      <p className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{who}</span>
          {internal ? (
            <span className="rounded-md bg-building px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-surface">Internal note</span>
          ) : m.authorRole === "agent" ? (
            <span className="text-muted">Reply to customer</span>
          ) : (
            <span className="text-muted">Customer</span>
          )}
          {m.aiAssisted && <span className="rounded-md border border-accent px-2 py-0.5 text-xs font-semibold text-accent">AI-assisted</span>}
        </span>
        <time dateTime={m.createdAt.toISOString()} className="text-muted">
          {formatWhen(m.createdAt)}
        </time>
      </p>
      {/* Plain text only. React escapes the body; never render it as HTML. */}
      <p className="whitespace-pre-wrap break-words">{m.body}</p>
      {internal && <p className="mt-1 text-xs text-muted">Customers never see internal notes.</p>}
    </li>
  );
}

function Clock({ label, state, due, done }: { label: string; state: SlaState; due: Date; done: Date | null }) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <StatusBadge status={SLA_TONE[state]} label={SLA_LABEL[state]} />
        <span className="text-muted">{done ? `done ${formatWhen(done)}` : `due ${formatWhen(due)}`}</span>
      </dd>
    </div>
  );
}
