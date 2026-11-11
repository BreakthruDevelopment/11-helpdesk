import { describe, expect, it } from "vitest";
import { NEXT_STATUSES, SLA_LABEL, SLA_TONE, countdown, queueView, triageDiff, withArticleLink } from "./desk-view";

const now = new Date("2026-01-01T12:00:00Z");

describe("countdown", () => {
  it("is null when nothing is ticking", () => {
    expect(countdown(null, now)).toBeNull();
  });
  it("shows minutes, hours and days ahead", () => {
    expect(countdown(new Date("2026-01-01T12:45:30Z"), now)).toBe("in 45m");
    expect(countdown("2026-01-01T15:20:00Z", now)).toBe("in 3h 20m");
    expect(countdown("2026-01-03T16:00:00Z", now)).toBe("in 2d 4h");
  });
  it("says overdue past the deadline, and due now within the minute", () => {
    expect(countdown("2026-01-01T11:48:00Z", now)).toBe("12m overdue");
    expect(countdown("2025-12-30T08:00:00Z", now)).toBe("2d 4h overdue");
    expect(countdown("2026-01-01T12:00:20Z", now)).toBe("due now");
  });
});

describe("labels", () => {
  it("covers every SLA state with words and a tone", () => {
    for (const s of ["ok", "at_risk", "breached", "met", "paused"] as const) {
      expect(SLA_LABEL[s]).toBeTruthy();
      expect(SLA_TONE[s]).toBeTruthy();
    }
    expect(SLA_TONE.breached).toBe("blocked");
  });
  it("never offers new as a target status", () => {
    for (const targets of Object.values(NEXT_STATUSES)) expect(targets).not.toContain("new");
  });
});

describe("queueView", () => {
  it("accepts the three views and defaults to unassigned", () => {
    expect(queueView("mine")).toBe("mine");
    expect(queueView("all")).toBe("all");
    expect(queueView(undefined)).toBe("unassigned");
    expect(queueView("everything")).toBe("unassigned");
    expect(queueView(["mine"])).toBe("unassigned");
  });
});

describe("triageDiff", () => {
  it("returns only what differs from the ticket", () => {
    expect(triageDiff({ category: "billing", priority: "normal" }, { category: "billing", priority: "high" })).toEqual({ category: null, priority: "high" });
    expect(triageDiff({ category: "other", priority: "low" }, { category: "bug", priority: "low" })).toEqual({ category: "bug", priority: null });
    expect(triageDiff({ category: "bug", priority: "low" }, { category: "bug", priority: "low" })).toEqual({ category: null, priority: null });
  });
});

describe("withArticleLink", () => {
  const a = { title: "Reset your password", slug: "reset-your-password" };
  it("adds the link on its own line, once", () => {
    expect(withArticleLink("", a)).toBe("Reset your password: /kb/reset-your-password");
    const once = withArticleLink("Hi there.  \n", a, "https://x.test");
    expect(once).toBe("Hi there.\n\nReset your password: https://x.test/kb/reset-your-password");
    expect(withArticleLink(once, a, "https://x.test")).toBe(once);
  });
});
