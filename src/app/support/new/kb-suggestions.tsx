"use client";

import { useEffect, useState } from "react";

type Suggestion = { id: string; slug: string; title: string };

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

/** Published articles that match what the customer is typing as the subject (public search, top 5, text only). */
export function KbSuggestions({ subject }: { subject: string }) {
  const q = subject.trim();
  const [found, setFound] = useState<{ q: string; items: Suggestion[] } | null>(null);

  useEffect(() => {
    if (q.length < MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/kb?${new URLSearchParams({ q: q.slice(0, 200), limit: "5" })}`, { signal: controller.signal });
        if (!res.ok) return;
        const data: { articles?: Suggestion[] } = await res.json();
        setFound({ q, items: Array.isArray(data.articles) ? data.articles.slice(0, 5) : [] });
      } catch {
        // Suggestions are a convenience: a failed or aborted lookup just shows nothing.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const items = q.length >= MIN_CHARS && found?.q === q ? found.items : [];
  if (items.length === 0) return null;
  return (
    <aside aria-label="Suggested articles" className="min-w-0 rounded-card border border-border bg-accent-soft p-3 text-sm">
      <p className="mb-2 font-semibold">These articles might answer it</p>
      <ul className="space-y-1">
        {items.map((a) => (
          <li key={a.id} className="min-w-0">
            <a href={`/kb/${a.slug}`} target="_blank" rel="noreferrer" className="break-words text-accent underline">
              {a.title}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
