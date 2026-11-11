import { describe, expect, it } from "vitest";
import {
  type SlaTicket,
  SLA_HOURS,
  dueTimes,
  firstResponseDueAt,
  firstResponseState,
  nextDueAt,
  pausedFor,
  resolutionDueAt,
  resolutionState,
  resumeClock,
  slaState,
  slaView,
} from "./sla";

const created = new Date("2026-11-09T10:00:00Z");
const hours = (h: number) => new Date(created.getTime() + h * 3_600_000);

describe("SLA windows (spec table)", () => {
  it.each([
    ["urgent", 1, 8],
    ["high", 4, 24],
    ["normal", 8, 72],
    ["low", 24, 120],
  ] as const)("%s: first response %i h, resolution %i h", (priority, first, resolution) => {
    expect(SLA_HOURS[priority]).toEqual({ firstResponse: first, resolution });
    expect(firstResponseDueAt(priority, created)).toEqual(hours(first));
    expect(resolutionDueAt(priority, created, 0)).toEqual(hours(resolution));
  });

  it("moves the resolution deadline by the time spent waiting on the customer", () => {
    expect(resolutionDueAt("high", created, 7200)).toEqual(hours(26));
  });

  it("recomputes from created_at, so a priority change never compounds", () => {
    expect(resolutionDueAt("urgent", created, 0)).toEqual(hours(8));
    expect(resolutionDueAt("normal", created, 0)).toEqual(hours(72));
  });

  it("counts whole paused seconds and never goes negative", () => {
    expect(pausedFor(created, hours(2))).toBe(7200);
    expect(pausedFor(hours(2), created)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// slaState and the transitions
// ---------------------------------------------------------------------------

const H = 3_600_000;
const at = (h: number) => new Date(created.getTime() + h * H);

/** An open, unanswered normal ticket created at `created`: first response due +8 h, resolution +72 h. */
function ticket(over: Partial<SlaTicket> = {}): SlaTicket {
  return {
    status: "open",
    priority: "normal",
    createdAt: created,
    firstResponseDueAt: at(8),
    resolutionDueAt: at(72),
    firstRespondedAt: null,
    resolvedAt: null,
    pausedAt: null,
    pausedSeconds: 0,
    breachedFirstResponseAt: null,
    breachedResolutionAt: null,
    ...over,
  };
}
const answered = (h: number) => ({ firstRespondedAt: at(h) });

describe("first response clock, every priority", () => {
  it.each([
    ["urgent", 1],
    ["high", 4],
    ["normal", 8],
    ["low", 24],
  ] as const)("%s: ok, at risk in the last 25%% of %i h, then breached", (priority, hours) => {
    const t = ticket({ priority, ...dueTimes(priority, created, 0) });
    expect(firstResponseState(t, created)).toBe("ok");
    expect(firstResponseState(t, at(hours * 0.74))).toBe("ok");
    expect(firstResponseState(t, at(hours * 0.76))).toBe("at_risk");
    expect(firstResponseState(t, at(hours))).toBe("at_risk"); // due exactly now is not late yet
    expect(firstResponseState(t, new Date(at(hours).getTime() + 1))).toBe("breached");
  });

  it("is met by a reply in time, breached by a late reply, and a recorded breach always wins", () => {
    expect(firstResponseState(ticket(answered(7.9)), at(100))).toBe("met");
    expect(firstResponseState(ticket(answered(9)), at(100))).toBe("breached");
    expect(firstResponseState(ticket({ ...answered(1), breachedFirstResponseAt: at(8) }), at(2))).toBe("breached");
  });

  it("a ticket resolved before the deadline without a reply is not a first-response breach; one resolved late is", () => {
    expect(firstResponseState(ticket({ status: "resolved", resolvedAt: at(5) }), at(100))).toBe("met");
    expect(firstResponseState(ticket({ status: "resolved", resolvedAt: at(9) }), at(100))).toBe("breached");
  });
});

describe("resolution clock, every priority", () => {
  it.each([
    ["urgent", 8],
    ["high", 24],
    ["normal", 72],
    ["low", 120],
  ] as const)("%s: ok, at risk in the last 25%% of %i h, then breached", (priority, hours) => {
    const t = ticket({ priority, ...answered(0.5), ...dueTimes(priority, created, 0) });
    expect(resolutionState(t, created)).toBe("ok");
    expect(resolutionState(t, at(hours * 0.74))).toBe("ok");
    expect(resolutionState(t, at(hours * 0.76))).toBe("at_risk");
    expect(resolutionState(t, new Date(at(hours).getTime() + 1))).toBe("breached");
  });

  it("is met when resolved in time and breached when resolved late", () => {
    expect(resolutionState(ticket({ status: "resolved", resolvedAt: at(70) }), at(200))).toBe("met");
    expect(resolutionState(ticket({ status: "resolved", resolvedAt: at(73) }), at(200))).toBe("breached");
  });

  it("is paused while waiting on the customer and never breaches then, however long", () => {
    const t = ticket({ status: "pending_customer", ...answered(1), pausedAt: at(10) });
    expect(resolutionState(t, at(11))).toBe("paused");
    expect(resolutionState(t, at(1000))).toBe("paused");
  });
});

describe("slaState (the chip)", () => {
  it("is ok for a fresh ticket and at_risk when either clock is in its last quarter", () => {
    expect(slaState(ticket(), at(1))).toBe("ok");
    expect(slaState(ticket(), at(7))).toBe("at_risk"); // first response: 1 h of 8 left
    expect(slaState(ticket(answered(1)), at(7))).toBe("ok"); // answered: only the 72 h clock matters
    expect(slaState(ticket(answered(1)), at(60))).toBe("at_risk"); // 12 h of 72 left
  });

  it("is breached when either clock is, even on a resolved ticket", () => {
    expect(slaState(ticket(), at(9))).toBe("breached");
    expect(slaState(ticket(answered(1)), at(73))).toBe("breached");
    expect(slaState(ticket({ status: "resolved", ...answered(9), resolvedAt: at(10) }), at(11))).toBe("breached");
  });

  it("is met for a ticket resolved in time and paused while waiting on the customer", () => {
    expect(slaState(ticket({ status: "resolved", ...answered(2), resolvedAt: at(30) }), at(31))).toBe("met");
    expect(slaState(ticket({ status: "pending_customer", ...answered(2), pausedAt: at(10) }), at(500))).toBe("paused");
  });

  it("a paused ticket with no reply yet still counts the first-response clock", () => {
    const t = ticket({ status: "pending_customer", pausedAt: at(1) });
    expect(slaState(t, at(2))).toBe("paused");
    expect(slaState(t, at(7))).toBe("at_risk");
    expect(slaState(t, at(9))).toBe("breached");
  });

  it("slaView bundles both clocks and the next deadline", () => {
    expect(slaView(ticket(answered(1)), at(2))).toEqual({ state: "ok", firstResponse: "met", resolution: "ok", nextDueAt: at(72) });
  });
});

describe("nextDueAt (what the queue sorts by)", () => {
  it("is the first-response deadline until a reply, then the resolution deadline", () => {
    expect(nextDueAt(ticket())).toEqual(at(8));
    expect(nextDueAt(ticket(answered(1)))).toEqual(at(72));
  });
  it("is null for resolved tickets and for tickets waiting on the customer after a reply", () => {
    expect(nextDueAt(ticket({ status: "resolved", resolvedAt: at(3) }))).toBeNull();
    expect(nextDueAt(ticket({ status: "pending_customer", ...answered(1), pausedAt: at(2) }))).toBeNull();
  });
});

describe("pause and resume", () => {
  it("resuming moves the resolution deadline by exactly the time paused and adds it to the total", () => {
    const paused = { pausedAt: at(10), pausedSeconds: 1800, resolutionDueAt: at(72.5) };
    expect(resumeClock(paused, at(14))).toEqual({ pausedAt: null, pausedSeconds: 1800 + 4 * 3600, resolutionDueAt: at(76.5) });
  });

  it("resuming a ticket that isn't paused changes nothing", () => {
    expect(resumeClock({ pausedAt: null, pausedSeconds: 60, resolutionDueAt: at(72) }, at(99))).toEqual({
      pausedAt: null,
      pausedSeconds: 60,
      resolutionDueAt: at(72),
    });
  });

  it("two pauses add up, and the deadline always equals created + window + total paused", () => {
    const first = resumeClock({ pausedAt: at(2), pausedSeconds: 0, resolutionDueAt: at(72) }, at(5));
    const second = resumeClock({ ...first, pausedAt: at(20) }, at(21));
    expect(second.pausedSeconds).toBe(4 * 3600);
    expect(second.resolutionDueAt).toEqual(resolutionDueAt("normal", created, second.pausedSeconds));
  });

  it("a clock that was paused isn't at risk or breached until it resumes", () => {
    const resumed = resumeClock({ pausedAt: at(10), pausedSeconds: 0, resolutionDueAt: at(72) }, at(60));
    expect(resumed.resolutionDueAt).toEqual(at(122));
    expect(resolutionState(ticket({ ...answered(1), ...resumed }), at(100))).toBe("ok");
  });
});

describe("priority change", () => {
  it("recomputes both deadlines from created_at, keeping time already spent paused", () => {
    expect(dueTimes("urgent", created, 0)).toEqual({ firstResponseDueAt: at(1), resolutionDueAt: at(8) });
    expect(dueTimes("high", created, 3600)).toEqual({ firstResponseDueAt: at(4), resolutionDueAt: at(25) });
  });

  it("is idempotent and order-independent: normal to urgent to normal lands back on the original deadlines", () => {
    const back = dueTimes("normal", created, 0);
    expect(back).toEqual({ firstResponseDueAt: at(8), resolutionDueAt: at(72) });
    expect(dueTimes("normal", created, 0)).toEqual(back);
  });

  it("a ticket that was fine at normal can be breached at urgent the moment the priority rises", () => {
    const urgent = ticket({ priority: "urgent", ...dueTimes("urgent", created, 0) });
    expect(slaState(ticket(), at(3))).toBe("ok");
    expect(slaState(urgent, at(3))).toBe("breached");
  });
});
