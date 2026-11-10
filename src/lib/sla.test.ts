import { describe, expect, it } from "vitest";
import { SLA_HOURS, firstResponseDueAt, pausedFor, resolutionDueAt } from "./sla";

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
