"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { formatWhen } from "@/components/format-when";
import { DemoBadge, StatusBadge } from "@/components/ui";
import { buttonOutlineAccent, buttonPrimary, buttonSecondary, labelClass, textareaClass } from "@/components/ui/styles";
import type { ReplySuggestionView } from "@/lib/support-ai";
import type { DeskFormState } from "../actions";
import { NeedsHuman } from "../badges";
import { useComposer } from "./composer-context";

type Props = {
  send: (prev: DeskFormState, formData: FormData) => Promise<DeskFormState>;
  suggest: () => Promise<{ suggestion: ReplySuggestionView | null; error: string | null }>;
  /** The newest stored draft, offered with "Load it", never put in the box on its own. */
  latest: ReplySuggestionView | null;
  bodyMax: number;
  reopens: boolean;
};

const CONFIDENCE: Record<ReplySuggestionView["confidence"], string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };

/**
 * Reply or internal note. Pinned to the bottom of the screen on phones. An AI draft only ever lands in this box when
 * the agent asks for it; it is plain text the agent edits, and nothing goes out until they press Send.
 */
export function Composer({ send, suggest, latest, bodyMax, reopens }: Props) {
  const { body, setBody, draft, loadDraft, discardDraft, reset } = useComposer();
  const [mode, setMode] = useState<"public" | "internal">("public");
  const [state, formAction, sending] = useActionState(send, { error: null, done: 0 });
  const [asking, startAsking] = useTransition();
  const [aiError, setAiError] = useState<string | null>(null);
  const lastDone = useRef(0);

  useEffect(() => {
    if (state.done !== lastDone.current) {
      lastDone.current = state.done;
      reset();
    }
  }, [state.done, reset]);

  const busy = sending || asking;
  const aiAssisted = mode === "public" && draft !== null;
  const offerLatest = latest !== null && draft === null && body.trim() === "";

  function askForDraft() {
    setAiError(null);
    startAsking(async () => {
      const r = await suggest();
      if (r.error) setAiError(r.error);
      else if (r.suggestion) {
        loadDraft(r.suggestion);
        setMode("public");
      }
    });
  }

  return (
    <section
      aria-labelledby="composer-title"
      className="rounded-card border border-border bg-surface p-4 shadow-sm max-lg:max-h-[60dvh] max-lg:overflow-y-auto sm:p-6"
    >
      <h2 id="composer-title" className="mb-3 font-display text-xl font-semibold max-sm:sr-only">
        {mode === "internal" ? "Internal note" : "Reply to customer"}
      </h2>
      {/* Below 1024px the composer is a pinned strip: the text box and Send come first, the draft details (sources, Discard) after them. */}
      <form action={formAction} className="space-y-3 max-lg:flex max-lg:flex-col max-lg:gap-3 max-lg:space-y-0">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Message type</legend>
          {(
            [
              ["public", "Reply"],
              ["internal", "Internal note"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="cursor-pointer">
              <input type="radio" name="visibility" value={v} checked={mode === v} onChange={() => setMode(v)} disabled={busy} className="peer sr-only" />
              <span
                className={`inline-flex min-h-11 items-center rounded-card border px-4 text-sm font-semibold peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
                  mode === v
                    ? v === "internal"
                      ? "border-building bg-building-soft text-building"
                      : "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-surface text-foreground"
                }`}
              >
                {label}
              </span>
            </label>
          ))}
        </fieldset>

        {draft && <DraftInfo draft={draft} internal={mode === "internal"} onDiscard={discardDraft} disabled={busy} />}
        {offerLatest && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>An AI draft from {formatWhen(new Date(latest.createdAt))} is saved.</span>
            <button type="button" onClick={() => loadDraft(latest)} disabled={busy} className={buttonSecondary}>
              Load AI draft
            </button>
          </p>
        )}

        <label className={labelClass}>
          <span>{draft && mode === "public" ? "AI draft (edit before sending)" : mode === "internal" ? "Note for agents only" : "Message to the customer"}</span>
          <textarea
            name="body"
            required
            maxLength={bodyMax}
            rows={draft ? 8 : 3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            className={`${textareaClass} max-lg:h-36 max-lg:min-h-28 ${mode === "internal" ? "border-dashed border-building bg-building-soft" : ""}`}
          />
        </label>
        <input type="hidden" name="aiAssisted" value={aiAssisted ? "true" : "false"} />
        <p className="text-sm text-muted">
          {mode === "internal"
            ? "Only agents see notes. Customers and notifications never do."
            : reopens
              ? "Sending a reply reopens this resolved ticket."
              : "The customer sees this reply and gets a notification."}
        </p>

        {(state.error || aiError) && (
          <p role="alert" className="text-sm font-medium text-danger">
            {state.error ?? aiError}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy || body.trim() === ""} className={`${buttonPrimary} max-sm:flex-1`}>
            {sending ? "Sending…" : mode === "internal" ? "Save note" : "Send reply"}
          </button>
          <button type="button" onClick={askForDraft} disabled={busy} className={`${buttonOutlineAccent} max-sm:flex-1`}>
            {asking ? "Drafting…" : draft ? "New AI draft" : "Suggest reply"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DraftInfo({ draft, internal, onDiscard, disabled }: { draft: ReplySuggestionView; internal: boolean; onDiscard: () => void; disabled: boolean }) {
  return (
    <div className="space-y-2 rounded-card border border-accent bg-accent-soft p-3 text-sm max-lg:order-last" role="note" aria-label="AI draft details">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-accent">AI draft</span>
        <span className="text-muted">Not sent. Read it, edit it, then press Send.</span>
        {draft.demo && <DemoBadge label="Demo AI" />}
      </p>
      {internal && <p className="font-medium">This is now an internal note, so it won&apos;t be marked AI-assisted or sent to the customer.</p>}
      <ul aria-label="Policy checks" className="flex flex-wrap gap-2">
        <li>
          <StatusBadge status={draft.confidence === "low" ? "degraded" : "not-started"} label={CONFIDENCE[draft.confidence]} />
        </li>
        {draft.needsHumanBecause && (
          <li>
            <NeedsHuman reason={draft.needsHumanBecause} />
          </li>
        )}
        {draft.policy.map((p) => (
          <li key={p.code}>
            <StatusBadge status="degraded" label={p.label} />
          </li>
        ))}
        {draft.linksRemoved > 0 && (
          <li>
            <StatusBadge status="degraded" label={`${draft.linksRemoved} link${draft.linksRemoved === 1 ? "" : "s"} removed`} />
          </li>
        )}
      </ul>
      {draft.stale && <p className="font-medium text-building">The customer wrote again after this draft was made. Check it still fits, or ask for a new one.</p>}
      {draft.citations.length > 0 ? (
        <div>
          <p className="font-semibold">Based on</p>
          <ul className="space-y-1">
            {draft.citations.map((c) => (
              <li key={c.ref} className="break-words">
                <span className="text-muted">[{c.ref}]</span>{" "}
                <Link href={`/kb/${c.slug}`} target="_blank" className="inline-flex min-h-11 items-center text-accent underline">
                  {c.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted">No help articles were cited.</p>
      )}
      <button type="button" onClick={onDiscard} disabled={disabled} className={buttonSecondary}>
        Discard draft
      </button>
    </div>
  );
}
