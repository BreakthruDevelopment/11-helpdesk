/**
 * A deliberately tiny Markdown subset for knowledge-base articles: paragraphs, line breaks, `**bold**`, `- ` and
 * `1. ` lists, and `[text](url)` links for http(s) URLs only. It parses to plain data (no HTML strings anywhere);
 * `src/components/kb-body.tsx` turns that data into React elements, which escape every string. Anything it doesn't
 * understand, including raw HTML, `javascript:` links and unbalanced markers, stays literal text.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; items: Inline[][] };

const UL_ITEM = /^\s{0,3}[-*]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const TOKEN = /\*\*([^*]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** The URL to link to, or null unless it is a plain http(s) URL. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += t;
    else out.push({ type: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    pushText(text.slice(at, index));
    if (m[1] !== undefined) {
      out.push({ type: "bold", children: parseInline(m[1]) });
    } else {
      const href = safeHref(m[3] ?? "");
      if (href) out.push({ type: "link", href, children: [{ type: "text", text: m[2] ?? "" }] });
      else pushText(m[0]);
    }
    at = index + m[0].length;
  }
  pushText(text.slice(at));
  return out;
}

export function parseMarkdown(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: Inline[][] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const children: Inline[] = [];
    para.forEach((line, i) => {
      if (i > 0) children.push({ type: "br" });
      children.push(...parseInline(line.trim()));
    });
    blocks.push({ type: "paragraph", children });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const ul = UL_ITEM.exec(line);
    const ol = ul ? null : OL_ITEM.exec(line);
    const item = ul ?? ol;
    if (item) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push(parseInline((item[1] ?? "").trim()));
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** Plain text for list excerpts: markers removed, links reduced to their text, whitespace collapsed. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}(?:[-*]|\d{1,3}[.)])\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)?/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
