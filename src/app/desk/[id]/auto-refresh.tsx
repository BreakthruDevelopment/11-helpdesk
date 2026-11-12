"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the open ticket every 20 s while the tab is visible (the spec's only polling). Typed text is kept. */
export function AutoRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const t = setInterval(tick, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
