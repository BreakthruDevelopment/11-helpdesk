"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ReplySuggestionView } from "@/lib/support-ai";
import { withArticleLink } from "@/lib/desk-view";

type Composer = {
  body: string;
  setBody: (v: string) => void;
  /** The AI draft the box was filled from, or null. While set, a public send is marked AI-assisted. */
  draft: ReplySuggestionView | null;
  loadDraft: (d: ReplySuggestionView) => void;
  discardDraft: () => void;
  addArticle: (a: { title: string; slug: string }) => void;
  reset: () => void;
};

const Ctx = createContext<Composer | null>(null);

/** Shares the reply box between the composer and the triage card ("Add link to reply"). Client state only. */
export function ComposerProvider({ children }: { children: ReactNode }) {
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<ReplySuggestionView | null>(null);
  const loadDraft = useCallback((d: ReplySuggestionView) => {
    setDraft(d);
    setBody(d.reply);
  }, []);
  const discardDraft = useCallback(() => {
    setDraft(null);
    setBody("");
  }, []);
  const addArticle = useCallback((a: { title: string; slug: string }) => {
    setBody((b) => withArticleLink(b, a, window.location.origin));
  }, []);
  const reset = useCallback(() => {
    setDraft(null);
    setBody("");
  }, []);
  const value = useMemo(() => ({ body, setBody, draft, loadDraft, discardDraft, addArticle, reset }), [body, draft, loadDraft, discardDraft, addArticle, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComposer(): Composer {
  const c = useContext(Ctx);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
