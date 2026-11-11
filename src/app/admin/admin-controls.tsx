"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { authClient } from "@/lib/auth/client";

/**
 * Grant or remove the agent role through Better Auth's admin endpoint (admins only, one role per account, logged by
 * the role audit hook). Admin accounts are not changed from here.
 */
export function AgentRoleButton({ userId, name, role }: { userId: string; name: string; role: "user" | "agent" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = role === "agent" ? "user" : "agent";
  async function change() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.admin.setRole({ userId, role: next });
      if (result.error) setError(result.error.message ?? "Couldn't change the role.");
      else router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={change}
        className={`${buttonSecondary} w-full sm:w-auto`}
        aria-label={next === "agent" ? `Make ${name} an agent` : `Make ${name} a customer`}
      >
        {pending ? "Saving…" : next === "agent" ? "Make agent" : "Make customer"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** POST /api/admin/demo: replaces the demo users' tickets with the sample workspace. Rate limited on the server. */
export function DemoButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  async function load() {
    setPending(true);
    setError(null);
    setDone("");
    try {
      const res = await fetch("/api/admin/demo", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; users?: number; tickets?: number; messages?: number };
      if (!res.ok) setError(body.error ?? "Couldn't load the demo workspace.");
      else {
        setDone(`Loaded ${body.users ?? 0} demo accounts, ${body.tickets ?? 0} tickets and ${body.messages ?? 0} messages.`);
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        Replaces the demo customers&apos; tickets with the sample workspace (tickets in every state, one breached). Real accounts and tickets are never
        touched. Once a minute, five times a day.
      </p>
      <button type="button" disabled={pending} onClick={load} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
      <p aria-live="polite" className="text-sm">
        {done}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
