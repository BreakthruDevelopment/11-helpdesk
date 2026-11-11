import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertAgent, ticketScope } from "@/lib/access";
import { retrieveForAi, publishedByIds } from "@/lib/kb";
import { ModelNotReachedError, runReplySuggest, runTriage } from "@/lib/ai/support";
import { POLICY_LABELS, type PolicyCode, type SupportArticle, type TriageResult, triageResult } from "@/lib/ai/support-guardrails";
import { AiError } from "@/lib/ai/types";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { JobError, type JobHandler, kick } from "@/lib/jobs/worker";
import { enqueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { dueTimes } from "@/lib/sla";
import { type Tx, consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

/**
 * The helpdesk's AI features, around the model calls in src/lib/ai/support.ts: who may trigger them, what the model
 * may see, the budget, and what is written back.
 *
 * - Triage (`triage-ticket` job): runs once per ticket, automatically, right after the customer opens it. It writes
 *   the category, priority and a summary onto the ticket and marks it `triage_source = 'ai'` ("Set by AI") until an
 *   agent changes it. It can never touch status or assignee, can't pick `urgent` (not in the enum), and never writes
 *   anything a customer can read: `ticket.triage` is outside the customer column allow-list.
 * - Suggest reply (agent clicks): stores an AI draft for agents. It is never sent, never changes the ticket, and the
 *   model never sees internal notes or the customer's name.
 *
 * Budget: both charge the app-wide daily counter (`AI_DAILY_CAP`) before the model is called and refund it when the
 * call fails; agent-triggered runs also use a per-agent hourly rate. Hitting a limit leaves the ticket as it was.
 */

const { ticket, ticketMessage, replySuggestion } = schema;

export const SUPPORT_AI_LIMITS = {
  /** Agent-triggered triage runs per ticket, on top of the one automatic run. */
  retriagesPerTicket: 3,
  retriagesPerAgentHour: 30,
  suggestionsPerAgentHour: 20,
  /** How long creating a ticket waits for triage before responding (inline mode). */
  createBudgetMs: 10_000,
  /** How long an agent's queue load waits to drain triage left pending. */
  queueDrainBudgetMs: 5_000,
  candidates: 5,
  replyArticles: 3,
} as const;

export const TRIAGE_JOB_KIND = "triage-ticket";

const DAILY_CAP_MESSAGE = "The daily AI limit has been reached. Try again tomorrow.";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** One short transaction: the agent's hourly rate and the app-wide daily cap together, so neither is kept if the other refuses. */
async function reserveAgentCall(actor: Actor, kind: "retriage" | "suggest", perHour: number, rateMessage: string): Promise<void> {
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, kind, perHour, rateMessage);
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) throw new TooManyRequestsError(DAILY_CAP_MESSAGE);
  });
}

/** The model call never produced anything: give both reservations back (in a new transaction, never held across the call). */
async function refundAgentCall(actor: Actor, kind: "retriage" | "suggest"): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      await releaseRate(tx, actor.id, kind);
      await releaseDaily(tx, "ai");
    });
  } catch {
    log.warn("ai.refund_failed", { kind });
  }
}

// ---------------------------------------------------------------------------
// Inputs the model may see
// ---------------------------------------------------------------------------

type TicketRow = typeof ticket.$inferSelect;

/** Label articles K1..Kn: the model only ever names these labels, never an id. */
function label(articles: readonly { id: string; title: string; body: string }[]): SupportArticle[] {
  return articles.map((a, i) => ({ ref: `K${i + 1}`, id: a.id, title: a.title, body: a.body }));
}

/** The first public message from the customer. Public only, in SQL: an internal note can't be selected here. */
async function firstCustomerMessage(ticketId: string): Promise<string> {
  const [row] = await db()
    .select({ body: ticketMessage.body })
    .from(ticketMessage)
    .where(and(eq(ticketMessage.ticketId, ticketId), eq(ticketMessage.visibility, "public"), eq(ticketMessage.authorRole, "customer")))
    .orderBy(asc(ticketMessage.createdAt), asc(ticketMessage.id))
    .limit(1);
  return row?.body ?? "";
}

type StoredTriage = TriageResult & { retriages: number; demo: boolean; at: string };

function readStoredTriage(raw: unknown): StoredTriage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Pick the known fields: older or seeded rows carry others (`articleRefs`), which the strict schema would refuse.
  const parsed = triageResult.safeParse({
    category: o.category,
    priority: o.priority,
    summary: o.summary,
    sentiment: o.sentiment,
    articleIds: Array.isArray(o.articleIds) ? o.articleIds : [],
    needsHumanBecause: o.needsHumanBecause ?? null,
  });
  if (!parsed.success) return null;
  return { ...parsed.data, retriages: Number.isInteger(o.retriages) ? Number(o.retriages) : 0, demo: o.demo === true, at: typeof o.at === "string" ? o.at : "" };
}

const retriageCount = (row: Pick<TicketRow, "triage">) => {
  const n = (row.triage as { retriages?: unknown } | null)?.retriages;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
};

// ---------------------------------------------------------------------------
// Applying triage
// ---------------------------------------------------------------------------

/**
 * Write a triage result onto the ticket. The caller holds the row lock. Category and priority are applied only when
 * no agent has set either (`triage_source <> 'agent'`); the card (summary, sentiment, articles) is always stored.
 * Status, assignee and the customer-facing activity time are never touched. Returns what was applied.
 */
async function applyTriage(tx: Tx, row: TicketRow, result: TriageResult, opts: { demo: boolean; retriages: number }): Promise<{ category: boolean; priority: boolean }> {
  // Only AI-set tickets, or untouched ones that were never triaged, may be changed; never a recorded (demo) answer,
  // and never an urgent ticket (only agents set urgent, and the AI can't un-set it). Seeded or agent-edited tickets
  // carry `triage_source = 'agent'`.
  const eligible = !opts.demo && (row.triageSource === "ai" || (row.triageSource === "none" && row.triage === null));
  const apply = eligible && row.priority !== "urgent";
  const categoryChanged = apply && result.category !== row.category;
  const priorityChanged = apply && result.priority !== row.priority;
  const now = new Date();
  const stored = {
    category: result.category,
    priority: result.priority,
    summary: result.summary,
    sentiment: result.sentiment,
    articleIds: result.articleIds,
    needsHumanBecause: result.needsHumanBecause,
    retriages: opts.retriages,
    demo: opts.demo,
    at: now.toISOString(),
  };
  await tx
    .update(ticket)
    .set({
      triage: stored,
      ...(apply ? { triageSource: "ai" as const } : {}),
      ...(categoryChanged ? { category: result.category } : {}),
      ...(priorityChanged ? { priority: result.priority, ...dueTimes(result.priority, row.createdAt, row.pausedSeconds) } : {}),
      ...(categoryChanged || priorityChanged ? { updatedAt: now, version: sql`${ticket.version} + 1` } : {}),
    })
    .where(eq(ticket.id, row.id));
  return { category: categoryChanged, priority: priorityChanged };
}

// ---------------------------------------------------------------------------
// Automatic triage: the job
// ---------------------------------------------------------------------------

/** Called inside the create transaction: the job commits with the ticket or not at all. */
export async function enqueueTriage(tx: Tx, ticketId: string, customerId: string): Promise<string> {
  const { id } = await enqueue(tx, { kind: TRIAGE_JOB_KIND, key: ticketId, ownerId: customerId, payload: { ticketId }, maxAttempts: 2 });
  return id;
}

/**
 * Run the just-enqueued triage inside the request (inline mode on Cloud Run and Lambda; timer mode treats it as a
 * best-effort wait). Never throws and never waits past the budget: if triage doesn't finish, the ticket is saved
 * untriaged and the next agent queue load picks the job up.
 */
export async function runTriageNow(jobId: string): Promise<void> {
  await kick({ budgetMs: SUPPORT_AI_LIMITS.createBudgetMs, ids: [jobId] });
}

/** Agent queue loads finish triage that was left pending (a model timeout, a restart). Never throws. */
export async function drainPendingTriage(): Promise<void> {
  await kick({ budgetMs: SUPPORT_AI_LIMITS.queueDrainBudgetMs });
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new JobError("timeout"));
    signal.addEventListener("abort", () => reject(new JobError("timeout")), { once: true });
    work.then(resolve, reject);
  });
}

/** True when the failure happened before any request could have gone to the provider. */
function neverReached(err: unknown): boolean {
  return err instanceof ModelNotReachedError || (err instanceof AiError && err.kind === "input_rejected");
}

/** Map a failed model call to how the queue should treat it. */
function jobFailure(err: unknown): JobError {
  if (err instanceof JobError) return err;
  if (err instanceof AiError && (err.kind === "invalid_output" || err.kind === "input_rejected")) return new JobError("invalid_output", { permanent: true });
  if (err instanceof AiError && err.kind === "quota") return new JobError("quota", { deferMs: 60_000 });
  return new JobError("model_error");
}

/**
 * `triage-ticket`: idempotent, at most one successful run per ticket. A ticket that already has triage, or whose
 * category or priority an agent has set, is left alone. Unusable model output (invalid, `urgent`, an outage with a
 * live provider) leaves the ticket untriaged; nothing recorded is ever written in its place.
 */
export const triageTicketJob: JobHandler = async (job, ctx) => {
  const ticketId = z.string().uuid().safeParse((job.payload as { ticketId?: unknown }).ticketId);
  if (!ticketId.success) throw new JobError("bad_payload", { permanent: true });

  const [row] = await db().select().from(ticket).where(eq(ticket.id, ticketId.data));
  if (!row) return; // the ticket is gone
  if (row.triage !== null || row.triageSource !== "none") return; // already done, or an agent got there first

  const reserved = await reserveDaily(db(), "ai", env().AI_DAILY_CAP);
  if (!reserved) {
    log.warn("ai.budget_exhausted", { task: "ticket-triage" });
    return; // degrade: the ticket stays untriaged ("Triage pending"); an agent can run it tomorrow
  }

  let out;
  let reached = false;
  try {
    const message = await firstCustomerMessage(row.id);
    const candidates = label(await retrieveForAi(`${row.subject} ${message}`, SUPPORT_AI_LIMITS.candidates));
    reached = true;
    out = await untilAborted(runTriage({ subject: row.subject, firstMessage: message, candidates }).then((r) => ({ ...r, candidates })), ctx.signal);
  } catch (err) {
    // Refund only when the provider was never reached. A timeout, an outage, unusable output or a refused fallback
    // all cost a call (or may have), so they keep the charge.
    if (!reached || neverReached(err)) await releaseDaily(db(), "ai").catch(() => undefined);
    throw jobFailure(err);
  }

  if (ctx.signal.aborted) return;
  await db().transaction(async (tx) => {
    const [locked] = await tx.select().from(ticket).where(eq(ticket.id, row.id)).for("update");
    // Re-check under the lock: a second run, or an agent, may have finished first.
    if (!locked || locked.triage !== null || locked.triageSource !== "none") return;
    await applyTriage(tx, locked, out.result, { demo: out.demo, retriages: 0 });
  });
  log.info("ticket.triaged", { ticketId: row.id, how: "auto", demo: out.demo });
};

// ---------------------------------------------------------------------------
// Re-triage (agent)
// ---------------------------------------------------------------------------

export type ArticleRef = { id: string; slug: string; title: string };

export type TriageView = {
  category: TriageResult["category"];
  priority: TriageResult["priority"];
  summary: string;
  sentiment: TriageResult["sentiment"];
  needsHumanBecause: string | null;
  /** Published articles only, checked now: one unpublished since triage is left out. */
  articles: ArticleRef[];
  demo: boolean;
  at: string;
  retriagesLeft: number;
};

async function toTriageView(stored: StoredTriage): Promise<TriageView> {
  const articles = await publishedByIds(stored.articleIds);
  return {
    category: stored.category,
    priority: stored.priority,
    summary: stored.summary,
    sentiment: stored.sentiment,
    needsHumanBecause: stored.needsHumanBecause,
    articles: articles.map(({ id, slug, title }) => ({ id, slug, title })),
    demo: stored.demo,
    at: stored.at,
    retriagesLeft: Math.max(0, SUPPORT_AI_LIMITS.retriagesPerTicket - stored.retriages),
  };
}

/** A malformed id is a missing ticket, the same answer as an unknown one. */
function uuidOr404(id: string): string {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

async function agentTicket(actor: Actor, id: string): Promise<TicketRow> {
  assertAgent(actor);
  const [row] = await db()
    .select()
    .from(ticket)
    .where(and(eq(ticket.id, uuidOr404(id)), ticketScope({ kind: "agent", agentId: actor.id })));
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * An agent re-runs triage (3 per ticket, plus an hourly rate and the daily cap). The result replaces the triage card;
 * category and priority change only if no agent has set them. Agents only: anyone else is a 403.
 */
export async function retriage(actor: Actor, id: string): Promise<{ triage: TriageView; applied: { category: boolean; priority: boolean } }> {
  const row = await agentTicket(actor, id);
  const used = retriageCount(row);
  if (used >= SUPPORT_AI_LIMITS.retriagesPerTicket) throw new TooManyRequestsError("This ticket has already been re-triaged 3 times.");
  await reserveAgentCall(actor, "retriage", SUPPORT_AI_LIMITS.retriagesPerAgentHour, "You can re-triage 30 times per hour. Try again later.");

  let out;
  let reached = false;
  try {
    const message = await firstCustomerMessage(row.id);
    const candidates = label(await retrieveForAi(`${row.subject} ${message}`, SUPPORT_AI_LIMITS.candidates));
    reached = true;
    out = await runTriage({ subject: row.subject, firstMessage: message, candidates });
  } catch (err) {
    if (!reached || neverReached(err)) await refundAgentCall(actor, "retriage");
    throw err;
  }

  const { applied, count } = await db().transaction(async (tx) => {
    const [locked] = await tx.select().from(ticket).where(eq(ticket.id, row.id)).for("update");
    if (!locked) throw new NotFoundError();
    // The cap again under the lock: two clicks at once can't both be the third.
    const count = retriageCount(locked);
    if (count >= SUPPORT_AI_LIMITS.retriagesPerTicket) throw new TooManyRequestsError("This ticket has already been re-triaged 3 times.");
    return { applied: await applyTriage(tx, locked, out.result, { demo: out.demo, retriages: count + 1 }), count };
  });
  log.info("ticket.triaged", { ticketId: row.id, how: "agent", by: actor.id, demo: out.demo });
  return { triage: await toTriageView({ ...out.result, retriages: count + 1, demo: out.demo, at: new Date().toISOString() }), applied };
}

/** The ticket's triage as an agent sees it, or null when there is none yet. */
export async function getTriage(actor: Actor, id: string): Promise<TriageView | null> {
  const stored = readStoredTriage((await agentTicket(actor, id)).triage);
  return stored ? toTriageView(stored) : null;
}

// ---------------------------------------------------------------------------
// Suggested reply (agent)
// ---------------------------------------------------------------------------

export type ReplySuggestionView = {
  id: string;
  /** Plain text. Show it as text in the reply box; it is a draft until an agent sends it. */
  reply: string;
  confidence: "low" | "medium" | "high";
  needsHumanBecause: string | null;
  citations: (ArticleRef & { ref: string })[];
  /** Phrases to double-check, as a code and the fixed label to show. */
  policy: { code: PolicyCode; label: string }[];
  linksRemoved: number;
  demo: boolean;
  createdAt: Date;
  /** A newer public message arrived after the draft was made. */
  stale: boolean;
  aiGenerated: true;
};

const storedDraft = z.object({
  reply: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  needsHumanBecause: z.string().nullable(),
  refs: z.record(z.string(), z.string().uuid()),
  policy: z.array(z.string()),
  linksRemoved: z.number().int().min(0),
});

async function latestPublicMessageId(ticketId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: ticketMessage.id })
    .from(ticketMessage)
    .where(and(eq(ticketMessage.ticketId, ticketId), eq(ticketMessage.visibility, "public")))
    .orderBy(desc(ticketMessage.createdAt), desc(ticketMessage.id))
    .limit(1);
  return row?.id ?? null;
}

async function toSuggestionView(row: typeof replySuggestion.$inferSelect): Promise<ReplySuggestionView | null> {
  const data = storedDraft.safeParse(row.data);
  if (!data.success) return null;
  const published = await publishedByIds(row.articleIds);
  const byId = new Map(published.map((a) => [a.id, a]));
  const citations = Object.entries(data.data.refs)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([ref, id]) => {
      const a = byId.get(id);
      return a ? [{ ref, id: a.id, slug: a.slug, title: a.title }] : [];
    });
  const known = new Set<string>(Object.keys(POLICY_LABELS));
  return {
    id: row.id,
    reply: data.data.reply,
    confidence: data.data.confidence,
    needsHumanBecause: data.data.needsHumanBecause,
    citations,
    policy: data.data.policy.filter((c): c is PolicyCode => known.has(c)).map((code) => ({ code, label: POLICY_LABELS[code] })),
    linksRemoved: data.data.linksRemoved,
    demo: row.mode === "demo",
    createdAt: row.createdAt,
    stale: row.basedOnMessageId !== (await latestPublicMessageId(row.ticketId)),
    aiGenerated: true,
  };
}

/** The newest stored draft for a ticket, for agents; null when none was made. */
export async function getLatestSuggestion(actor: Actor, id: string): Promise<ReplySuggestionView | null> {
  const t = await agentTicket(actor, id);
  const [row] = await db().select().from(replySuggestion).where(eq(replySuggestion.ticketId, t.id)).orderBy(desc(replySuggestion.createdAt)).limit(1);
  return row ? toSuggestionView(row) : null;
}

/**
 * An agent asks for a draft reply. The model sees the subject and the newest public messages (never internal notes,
 * never the customer's name) and up to three published articles found by search (plus the triage's picks). The draft
 * is stored and returned to this agent; nothing is sent and the ticket is not changed.
 */
export async function suggestReply(actor: Actor, id: string): Promise<ReplySuggestionView> {
  const row = await agentTicket(actor, id);
  await reserveAgentCall(actor, "suggest", SUPPORT_AI_LIMITS.suggestionsPerAgentHour, "You can request 20 suggested replies per hour. Try again later.");

  let out;
  let reached = false;
  let basedOn: string | null = null;
  try {
    // Newest first, public only: `visibility = 'public'` is in the SQL, so a note is never read, let alone sent.
    const rows = await db()
      .select({ id: ticketMessage.id, authorRole: ticketMessage.authorRole, body: ticketMessage.body })
      .from(ticketMessage)
      .where(and(eq(ticketMessage.ticketId, row.id), eq(ticketMessage.visibility, "public")))
      .orderBy(desc(ticketMessage.createdAt), desc(ticketMessage.id))
      .limit(6);
    basedOn = rows[0]?.id ?? null;
    const messages = rows.reverse().map((m) => ({ role: m.authorRole, body: m.body }));
    const latestCustomer = [...messages].reverse().find((m) => m.role === "customer")?.body ?? "";

    const found = await retrieveForAi(`${row.subject} ${latestCustomer}`, SUPPORT_AI_LIMITS.replyArticles);
    const picks = readStoredTriage(row.triage)?.articleIds ?? [];
    const extra = (await publishedByIds(picks)).filter((a) => !found.some((f) => f.id === a.id));
    const articles = label([...found, ...extra].slice(0, SUPPORT_AI_LIMITS.replyArticles));

    reached = true;
    out = await runReplySuggest({ subject: row.subject, messages, articles });
  } catch (err) {
    if (!reached || neverReached(err)) await refundAgentCall(actor, "suggest");
    throw err;
  }

  const refs = Object.fromEntries(out.cited.map((a) => [a.ref, a.id]));
  const [saved] = await db()
    .insert(replySuggestion)
    .values({
      ticketId: row.id,
      basedOnMessageId: basedOn,
      data: { ...out.draft, refs, policy: out.policy, linksRemoved: out.linksRemoved },
      articleIds: out.cited.map((a) => a.id),
      mode: out.demo ? "demo" : "live",
      createdBy: actor.id,
    })
    .returning();
  const view = await toSuggestionView(saved);
  if (!view) throw new AiError("Model output failed validation", "invalid_output");
  return view;
}
