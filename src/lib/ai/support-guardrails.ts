import { z } from "zod";
import { TICKET_CATEGORIES } from "@/lib/db/schema";
import { AiError } from "./types";

/**
 * Guardrails for the two support AI tasks (`ticket-triage`, `reply-suggest`). Pure functions, no I/O.
 *
 * Design rule: model text is never trusted to be safe, and no denylist is relied on for safety. The things that
 * matter are structural: the model chooses from enums and from `K1..Kn` labels that the server maps to article ids
 * it has verified; free text (summary, draft reply) is shown to agents only, as plain text, labelled as AI output,
 * never sent to a customer, and has no path to ticket state, priority or assignee. The scans below (links, policy
 * phrases) reduce what an agent has to catch; they are aids, not the control.
 */

export const TRIAGE_LIMITS = { summaryMax: 240, needsHumanMax: 200, maxRefs: 3, maxCandidates: 5 } as const;
export const REPLY_LIMITS = { replyMax: 1500, needsHumanMax: 200, maxCitations: 3 } as const;

/** What an agent can see about an article a suggestion points at. Built by the server from published rows. */
export type SupportArticle = { ref: string; id: string; title: string; body: string };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Triage as the model must return it. `urgent` is not a priority the model can pick: the enum has three values, so
 * an answer that says `urgent` fails validation and the ticket is simply left untriaged. Free-text bounds are looser
 * than the stored ones (a slightly long summary is trimmed, not thrown away); refs are checked against the candidate
 * list afterwards.
 */
export const triageModelOutput = z.object({
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(["low", "normal", "high"]),
  summary: z.string().max(1000),
  sentiment: z.enum(["calm", "frustrated", "angry"]),
  articleRefs: z.array(z.string().max(12)).max(10),
  needsHumanBecause: z.string().max(1000).nullable(),
});
export type TriageModelOutput = z.infer<typeof triageModelOutput>;

/** Triage as stored on the ticket and shown to agents: article ids already verified against published articles. */
export const triageResult = z
  .object({
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(["low", "normal", "high"]),
    summary: z.string().min(1).max(TRIAGE_LIMITS.summaryMax),
    sentiment: z.enum(["calm", "frustrated", "angry"]),
    articleIds: z.array(z.string().uuid()).max(TRIAGE_LIMITS.maxRefs),
    needsHumanBecause: z.string().max(TRIAGE_LIMITS.needsHumanMax).nullable(),
  })
  .strict();
export type TriageResult = z.infer<typeof triageResult>;

/** The reply as the model returns it. Citation labels are checked against the provided set, not by pattern. */
export const replyModelOutput = z.object({
  reply: z.string().min(1).max(REPLY_LIMITS.replyMax),
  citations: z.array(z.string().max(12)).max(10),
  confidence: z.enum(["low", "medium", "high"]),
  needsHumanBecause: z.string().max(1000).nullable(),
});
export type ReplyModelOutput = z.infer<typeof replyModelOutput>;

/** The draft after the guardrails: the spec's output shape. */
export const replyDraft = z
  .object({
    reply: z.string().min(1).max(REPLY_LIMITS.replyMax),
    citations: z.array(z.string().regex(/^K[1-3]$/)).max(REPLY_LIMITS.maxCitations),
    confidence: z.enum(["low", "medium", "high"]),
    needsHumanBecause: z.string().max(REPLY_LIMITS.needsHumanMax).nullable(),
  })
  .strict();
export type ReplyDraft = z.infer<typeof replyDraft>;

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

// Zero-width, bidi-control and other invisible characters; C0/C1 controls except tab and newline.
const INVISIBLE_RANGES: [number, number][] = [
  [0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];
const hex = (c: number) => `\\u${c.toString(16).padStart(4, "0")}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`, "g");
// Ideographic and half-width full stops (U+3002, U+FF61, U+FE52) that NFKC leaves alone.
const FULL_STOPS = new RegExp(`[${[0x3002, 0xff61, 0xfe52].map(hex).join("")}]`, "g");

/** NFKC folds look-alike forms (full-width letters, ligatures); the ideographic full stop is folded by hand. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(FULL_STOPS, ".").replace(INVISIBLE, "");
}

/** Cut at `max` characters without splitting a surrogate pair, with an ellipsis when something was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Anything that reads as a link or an address: scheme URLs (including javascript: and data:), `www.` hosts, email
 * addresses and bare domains with a path or port. A bare domain is caught on purpose: "evil.example.com/login" has no
 * scheme and still sends an agent's customer somewhere.
 */
const LINKISH = new RegExp(
  [
    String.raw`\b(?:javascript|data|vbscript|mailto|tel|file|sms):[^\s<>"'\`]+`,
    String.raw`\b[a-z][a-z0-9+.-]{1,15}://[^\s<>"'\`]+`,
    String.raw`\bwww\.[^\s<>"'\`]+`,
    String.raw`[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+`,
    String.raw`\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b(?:[:/][^\s<>"'\`]*)?`,
  ].join("|"),
  "gi",
);

const TRAILING = /[.,;:!?)\]}>'"*_]+$/;

function linkCore(token: string): { core: string; tail: string } {
  const tail = token.match(TRAILING)?.[0] ?? "";
  return { core: token.slice(0, token.length - tail.length), tail };
}

const canonicalLink = (core: string) => core.toLowerCase().replace(/\/+$/, "");

/** Every link-like token in `text`, canonicalised. */
export function linkTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of normalize(text).matchAll(LINKISH)) out.add(canonicalLink(linkCore(m[0]).core));
  return out;
}

export const LINK_REMOVED = "[link removed]";

/** Replace each link-like token that isn't in `allowed` (canonical form). Returns the text and how many were removed. */
export function stripLinks(text: string, allowed: ReadonlySet<string> = new Set()): { text: string; removed: number } {
  let removed = 0;
  const out = normalize(text).replace(LINKISH, (token) => {
    const { core, tail } = linkCore(token);
    if (allowed.has(canonicalLink(core))) return token;
    removed += 1;
    return `${LINK_REMOVED}${tail}`;
  });
  return { text: out, removed };
}

// ---------------------------------------------------------------------------
// Policy phrases (a chip for the agent, never a block)
// ---------------------------------------------------------------------------

export const POLICY_RULES = [
  { code: "refund", label: "Mentions a refund", stems: ["refund", "reimburs", "money back", "chargeback"] },
  { code: "credit", label: "Mentions a credit", stems: ["credit"] },
  { code: "compensation", label: "Mentions compensation", stems: ["compensat"] },
  { code: "guarantee", label: "Promises or guarantees something", stems: ["guarant", "promise"] },
  { code: "discount", label: "Mentions a discount or waived fee", stems: ["discount", "waive", "free of charge", "coupon"] },
  { code: "legal", label: "Mentions legal matters", stems: ["lawsuit", "legal", "lawyer", "attorney", "liabilit"] },
  { code: "password", label: "Mentions a password", stems: ["password", "passcode"] },
  { code: "card", label: "Mentions card details", stems: ["card number", "card details", "cvv", "security code"] },
  { code: "identity", label: "Asks for identity or one-time codes", stems: ["social security", "ssn", "one-time code", "verification code", "2fa code"] },
] as const;
export type PolicyCode = (typeof POLICY_RULES)[number]["code"] | "timeframe";

export const POLICY_LABELS: Record<PolicyCode, string> = {
  ...Object.fromEntries(POLICY_RULES.map((r) => [r.code, r.label])),
  timeframe: "Promises a timeframe",
} as Record<PolicyCode, string>;

const TIMEFRAME = /\b(?:within|in|by)\s+(?:the\s+next\s+)?\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:minutes?|hours?|hrs?|days?|weeks?)\b|\b(?:today|tonight|tomorrow|asap|right away|immediately)\b/;

/**
 * Policy codes for phrases an agent should double-check before sending. Matched on the normalised text and on a
 * squashed copy (letters and digits only), so "r e f u n d" and "re-fund" are caught too. Stems of five characters or
 * fewer are only matched on the normalised text, where word boundaries keep false hits down.
 */
export function policyFlags(reply: string): PolicyCode[] {
  const text = normalize(reply).toLowerCase();
  const squashed = text.replace(/[^\p{L}\p{N}]+/gu, "");
  const found: PolicyCode[] = [];
  for (const rule of POLICY_RULES) {
    const hit = rule.stems.some((stem) => {
      if (stem.length <= 5) return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text);
      return text.includes(stem) || squashed.includes(stem.replace(/[^\p{L}\p{N}]+/gu, ""));
    });
    if (hit) found.push(rule.code);
  }
  if (TIMEFRAME.test(text)) found.push("timeframe");
  return found;
}

// ---------------------------------------------------------------------------
// Sanitising model output
// ---------------------------------------------------------------------------

/** One line of plain text: normalised, no links, whitespace collapsed, bounded. */
export function cleanLine(text: string, max: number): string {
  return truncate(stripLinks(text).text.replace(/\s+/g, " ").trim(), max);
}

/** Resolve `K1..Kn` labels to articles: unknown labels dropped, duplicates collapsed, at most `max` kept. */
export function resolveRefs(refs: readonly string[], articles: readonly SupportArticle[], max: number): SupportArticle[] {
  const byRef = new Map(articles.map((a) => [a.ref, a]));
  const picked: SupportArticle[] = [];
  for (const raw of refs) {
    const article = byRef.get(raw.trim().toUpperCase());
    if (article && !picked.includes(article)) picked.push(article);
    if (picked.length >= max) break;
  }
  return picked;
}

/** Validate triage output against what the server offered. Throws `AiError("invalid_output")` if nothing usable is left. */
export function sanitizeTriage(model: TriageModelOutput, candidates: readonly SupportArticle[]): TriageResult {
  const summary = cleanLine(model.summary, TRIAGE_LIMITS.summaryMax);
  const needs = model.needsHumanBecause ? cleanLine(model.needsHumanBecause, TRIAGE_LIMITS.needsHumanMax) : "";
  const parsed = triageResult.safeParse({
    category: model.category,
    priority: model.priority,
    summary: summary || "No summary available.",
    sentiment: model.sentiment,
    articleIds: resolveRefs(model.articleRefs, candidates, TRIAGE_LIMITS.maxRefs).map((a) => a.id),
    needsHumanBecause: needs || null,
  });
  if (!parsed.success) throw new AiError("Model output failed validation", "invalid_output");
  return parsed.data;
}

export type SanitizedReply = {
  draft: ReplyDraft;
  /** The cited articles, in citation order. */
  cited: SupportArticle[];
  policy: PolicyCode[];
  /** How many link-like tokens were removed because no cited article contained them. */
  linksRemoved: number;
};

/**
 * The reply guardrails: citations outside the provided set are dropped; links not present in a cited article are
 * removed; confidence is forced to `low` when there is nothing to ground the answer (no articles, or no valid
 * citation); policy phrases are flagged. Throws `AiError("invalid_output")` if nothing usable is left.
 */
export function sanitizeReply(model: ReplyModelOutput, articles: readonly SupportArticle[]): SanitizedReply {
  const cited = resolveRefs(model.citations, articles, REPLY_LIMITS.maxCitations);
  const allowed = new Set<string>();
  for (const a of cited) for (const t of linkTokens(`${a.title}\n${a.body}`)) allowed.add(t);

  const body = stripLinks(model.reply, allowed);
  const reply = truncate(body.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), REPLY_LIMITS.replyMax);
  const grounded = articles.length > 0 && cited.length > 0;
  let needs = model.needsHumanBecause ? cleanLine(model.needsHumanBecause, REPLY_LIMITS.needsHumanMax) : "";
  if (!grounded && !needs) needs = "No knowledge-base article covers this; the agent needs to check.";

  const parsed = replyDraft.safeParse({
    reply,
    citations: cited.map((a) => a.ref),
    confidence: grounded ? model.confidence : "low",
    needsHumanBecause: needs || null,
  });
  if (!parsed.success) throw new AiError("Model output failed validation", "invalid_output");
  return { draft: parsed.data, cited, policy: policyFlags(parsed.data.reply), linksRemoved: body.removed };
}
