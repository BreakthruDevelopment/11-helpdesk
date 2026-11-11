import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KbBody } from "@/components/kb-body";
import { stripMarkdown } from "./kb-markdown";

const html = (body: string) => renderToStaticMarkup(createElement(KbBody, { body }));

describe("KbBody", () => {
  it("renders paragraphs and keeps single line breaks", () => {
    expect(html("one\ntwo\n\nthree")).toBe('<div class="min-w-0 space-y-4 break-words"><p>one<br/>two</p><p>three</p></div>');
  });

  it("renders bold", () => {
    expect(html("a **b** c")).toContain("<p>a <strong>b</strong> c</p>");
  });

  it("renders unordered and ordered lists", () => {
    const out = html("- one\n- two\n\n1. first\n2. second");
    expect(out).toContain("<ul");
    expect(out).toContain("<li>one</li><li>two</li>");
    expect(out).toContain("<ol");
    expect(out).toContain("<li>first</li><li>second</li>");
  });

  it("renders http(s) links with safe attributes", () => {
    const out = html("see [the docs](https://example.com/a?b=1)");
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener nofollow ugc"');
    expect(out).toContain(">the docs</a>");
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "JaVaScRiPt:alert(1)", "/relative", "mailto:a@b.c"])("keeps a %s link as literal text", (url) => {
    const out = html(`[click](${url})`);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    expect(out).toContain("[click](");
  });

  it("escapes raw HTML", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> **<b>x</b>**');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  it("escapes quotes in a link text and URL", () => {
    const out = html('[a"b](https://example.com/"onmouseover="x)');
    // The quote is percent-encoded in the URL and escaped in the text, so no attribute can be injected.
    expect(out).toContain('href="https://example.com/%22onmouseover=%22x"');
    expect(out).toContain("a&quot;b</a>");
  });

  it("leaves unbalanced markers as text", () => {
    expect(html("**open and [broken](https://x")).toContain("<p>**open and [broken](https://x</p>");
    expect(html("a ** b")).toContain("a ** b");
    expect(html("[no url]()")).toContain("[no url]()");
  });

  it("renders nothing for an empty body", () => {
    expect(html("")).toBe('<div class="min-w-0 space-y-4 break-words"></div>');
  });
});

describe("stripMarkdown", () => {
  it("removes markers and keeps the words", () => {
    expect(stripMarkdown("- **Two** workspaces. See [billing](https://x.test/b).\n1. Next step")).toBe("Two workspaces. See billing. Next step");
  });

  it("drops stray markers from a truncated excerpt", () => {
    expect(stripMarkdown("Open **Settings > Bil…")).toBe("Open Settings > Bil…");
  });
});
