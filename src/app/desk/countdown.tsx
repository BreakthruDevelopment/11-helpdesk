"use client";

import { useEffect, useState } from "react";
import { countdown } from "@/lib/desk-view";

/**
 * The time left on the next SLA deadline, ticking once a minute. The server renders the first value; the client
 * keeps it current without refetching anything.
 */
export function Countdown({ due, overdueClass = "text-danger" }: { due: string | null; overdueClass?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const text = countdown(due, now);
  if (text === null) return <span className="text-muted">No clock running</span>;
  const overdue = text.endsWith("overdue");
  return (
    <time dateTime={due ?? undefined} suppressHydrationWarning className={overdue ? `font-semibold ${overdueClass}` : "text-foreground"}>
      {overdue ? text : `Due ${text}`}
    </time>
  );
}
