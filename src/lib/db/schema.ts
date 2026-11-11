import { sql } from "drizzle-orm";
import { boolean, check, customType, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Helpdesk domain. A ticket belongs to one customer (`customer_id`); agents see every ticket; admins see counts
// only. Which rows each role may read is decided in src/lib/access.ts, never in a route.
// ---------------------------------------------------------------------------

export const TICKET_STATUSES = ["new", "open", "pending_customer", "resolved"] as const;
export const TICKET_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const TICKET_CATEGORIES = ["billing", "technical", "account", "how_to", "bug", "feature_request", "other"] as const;
export const TRIAGE_SOURCES = ["ai", "agent", "none"] as const;
export const MESSAGE_VISIBILITIES = ["public", "internal"] as const;
export const MESSAGE_AUTHOR_ROLES = ["customer", "agent"] as const;
export const MAIL_KINDS = ["ticket_created", "agent_reply", "ticket_resolved", "ticket_assigned", "customer_reply"] as const;

const enumList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const ticket = pgTable(
  "ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("new"),
    priority: text("priority", { enum: TICKET_PRIORITIES }).notNull().default("normal"),
    category: text("category", { enum: TICKET_CATEGORIES }).notNull().default("other"),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    /** Written by the AI triage task (issue 11.3); never shown to customers. */
    triage: jsonb("triage").$type<Record<string, unknown>>(),
    triageSource: text("triage_source", { enum: TRIAGE_SOURCES }).notNull().default("none"),
    firstResponseDueAt: tstz("first_response_due_at").notNull(),
    resolutionDueAt: tstz("resolution_due_at").notNull(),
    firstRespondedAt: tstz("first_responded_at"),
    resolvedAt: tstz("resolved_at"),
    /** Set while the status is `pending_customer`: the resolution clock is stopped. */
    pausedAt: tstz("paused_at"),
    pausedSeconds: integer("paused_seconds").notNull().default(0),
    breachedFirstResponseAt: tstz("breached_first_response_at"),
    breachedResolutionAt: tstz("breached_resolution_at"),
    /** Optimistic locking: agents send the version they read; a stale one is a 409. */
    version: integer("version").notNull().default(1),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    /**
     * What a customer sees as "last updated" and sorts by: moved only by public messages (either side) and status
     * changes. `updated_at` also moves for internal notes and agent-only edits, so a customer must never read it.
     */
    publicActivityAt: tstz("public_activity_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_number_uidx").on(t.number),
    // Target of the composite foreign key from ticket_message: a message can only carry its ticket's customer.
    unique("ticket_id_customer_uq").on(t.id, t.customerId),
    index("ticket_status_due_idx").on(t.status, t.resolutionDueAt),
    index("ticket_customer_updated_idx").on(t.customerId, t.publicActivityAt),
    index("ticket_assignee_idx").on(t.assigneeId),
    check("ticket_status_chk", sql`${t.status} in (${enumList(TICKET_STATUSES)})`),
    check("ticket_priority_chk", sql`${t.priority} in (${enumList(TICKET_PRIORITIES)})`),
    check("ticket_category_chk", sql`${t.category} in (${enumList(TICKET_CATEGORIES)})`),
    check("ticket_triage_source_chk", sql`${t.triageSource} in (${enumList(TRIAGE_SOURCES)})`),
    check("ticket_subject_chk", sql`char_length(${t.subject}) between 1 and 150`),
    check("ticket_paused_chk", sql`${t.pausedSeconds} >= 0 and (${t.pausedAt} is null or ${t.status} = 'pending_customer')`),
  ],
);

export const ticketMessage = pgTable(
  "ticket_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull(),
    /** Same value as the ticket's customer; the composite key below makes any other value impossible. */
    customerId: text("customer_id").notNull(),
    /** Null once the author's account is deleted; the message stays with its ticket. */
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    authorRole: text("author_role", { enum: MESSAGE_AUTHOR_ROLES }).notNull(),
    visibility: text("visibility", { enum: MESSAGE_VISIBILITIES }).notNull().default("public"),
    body: text("body").notNull(),
    /** True when the agent started from an AI draft (issue 11.3). Never shown to customers. */
    aiAssisted: boolean("ai_assisted").notNull().default(false),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.ticketId, t.customerId], foreignColumns: [ticket.id, ticket.customerId], name: "ticket_message_ticket_customer_fk" }).onDelete("cascade"),
    index("ticket_message_thread_idx").on(t.ticketId, t.createdAt),
    check("ticket_message_visibility_chk", sql`${t.visibility} in (${enumList(MESSAGE_VISIBILITIES)})`),
    check("ticket_message_author_role_chk", sql`${t.authorRole} in (${enumList(MESSAGE_AUTHOR_ROLES)})`),
    // Customers can only ever write public messages; the database refuses an internal one with a customer role.
    check("ticket_message_internal_agent_chk", sql`${t.visibility} = 'public' or ${t.authorRole} = 'agent'`),
    check("ticket_message_body_chk", sql`char_length(${t.body}) between 1 and 5000`),
  ],
);

/** The simulated email outbox (src/lib/mail). One row per notification; the recipient reads it at /inbox. */
export const mailMessage = pgTable(
  "mail_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MAIL_KINDS }).notNull(),
    subject: text("subject").notNull(),
    snippet: text("snippet").notNull().default(""),
    readAt: tstz("read_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("mail_message_recipient_idx").on(t.recipientId, t.createdAt),
    index("mail_message_ticket_idx").on(t.ticketId),
    check("mail_message_kind_chk", sql`${t.kind} in (${enumList(MAIL_KINDS)})`),
    check("mail_message_subject_chk", sql`char_length(${t.subject}) <= 150`),
    check("mail_message_snippet_chk", sql`char_length(${t.snippet}) <= 200`),
  ],
);

export const KB_STATUSES = ["draft", "published"] as const;

/** Postgres full-text document. Only ever generated by the database (see `kbArticle.search`); never written. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Knowledge-base articles (src/lib/kb.ts). Written by agents only; the public sees `published` rows. `search` is a
 * generated column (English, title weight A, body weight B) behind a GIN index, so search needs no job or trigger.
 */
export const kbArticle = pgTable(
  "kb_article",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Markdown, rendered as text and links without raw HTML (the page's job). */
    body: text("body").notNull(),
    status: text("status", { enum: KB_STATUSES }).notNull().default("draft"),
    /** Null for seeded articles and once the author's account is deleted. */
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(sql`setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')`),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kb_article_slug_uidx").on(t.slug),
    index("kb_article_search_idx").using("gin", t.search),
    index("kb_article_status_updated_idx").on(t.status, t.updatedAt),
    check("kb_article_status_chk", sql`${t.status} in (${enumList(KB_STATUSES)})`),
    check("kb_article_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${t.slug}) <= 100`),
    check("kb_article_title_chk", sql`char_length(${t.title}) between 1 and 150`),
    check("kb_article_body_chk", sql`char_length(${t.body}) between 1 and 10000`),
  ],
);

export const SUGGESTION_MODES = ["demo", "live"] as const;

/**
 * AI reply drafts (src/lib/support-ai.ts). Agents only: a customer never reads this table, and nothing here is sent
 * anywhere; the draft only fills an agent's reply box. `data` holds the guardrail-checked draft, `article_ids` the
 * published articles it cites (re-checked against `published` when read). The newest row per ticket is the one shown.
 */
export const replySuggestion = pgTable(
  "reply_suggestion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    /** The newest public message when the draft was made; a newer one makes the draft stale. */
    basedOnMessageId: uuid("based_on_message_id").references(() => ticketMessage.id, { onDelete: "set null" }),
    data: jsonb("data").notNull().$type<Record<string, unknown>>(),
    articleIds: uuid("article_ids").array().notNull().default(sql`'{}'::uuid[]`),
    mode: text("mode", { enum: SUGGESTION_MODES }).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("reply_suggestion_ticket_idx").on(t.ticketId, t.createdAt),
    check("reply_suggestion_mode_chk", sql`${t.mode} in (${enumList(SUGGESTION_MODES)})`),
    check("reply_suggestion_articles_chk", sql`cardinality(${t.articleIds}) <= 3`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

// `api_write` and `upload` stay from the template (its tests use them). `ticket` is per hour and `ticket_day` per day:
// consumeRate prunes rows older than the window it is called with, so one kind can't carry two windows.
export const RATE_KINDS = ["api_write", "ai", "upload", "ticket", "ticket_day", "message", "kb_write", "retriage", "suggest", "demo_load"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type Ticket = typeof ticket.$inferSelect;
export type TicketMessage = typeof ticketMessage.$inferSelect;
export type KbArticle = typeof kbArticle.$inferSelect;
export type MailMessage = typeof mailMessage.$inferSelect;
export type Job = typeof job.$inferSelect;
