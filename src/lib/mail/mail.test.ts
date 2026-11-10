import { describe, expect, it } from "vitest";
import { SNIPPET_MAX, SUBJECT_MAX, mailMessageInput, publicSnippet, subjectFor } from "./index";

describe("publicSnippet", () => {
  it("builds a snippet from a public message, whitespace collapsed", () => {
    expect(publicSnippet({ visibility: "public", body: "Hello\n\n  there" })).toBe("Hello there");
  });

  it("refuses an internal note, so a note can't be turned into a notification", () => {
    expect(() => publicSnippet({ visibility: "internal", body: "customer is on a legacy discount" })).toThrow(/Internal notes/);
  });

  it("never exceeds 200 characters", () => {
    const snippet = publicSnippet({ visibility: "public", body: "x".repeat(5000) });
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("subjectFor and the message schema", () => {
  it("clips to 150 characters and never returns an empty subject", () => {
    expect(subjectFor("y".repeat(400)).length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(subjectFor("   ")).toBe("Support ticket");
  });

  it("rejects an over-long snippet or subject at the seam", () => {
    const ok = { recipientId: "u", kind: "agent_reply", ticketId: "7f0c1d9e-7a3b-4c52-9d8e-0a1b2c3d4e5f", subject: "s", snippet: "n" };
    expect(mailMessageInput.safeParse(ok).success).toBe(true);
    expect(mailMessageInput.safeParse({ ...ok, snippet: "n".repeat(201) }).success).toBe(false);
    expect(mailMessageInput.safeParse({ ...ok, subject: "s".repeat(151) }).success).toBe(false);
    expect(mailMessageInput.safeParse({ ...ok, kind: "newsletter" }).success).toBe(false);
  });
});
