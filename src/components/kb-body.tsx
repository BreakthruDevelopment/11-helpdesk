import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/kb-markdown";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return <Fragment key={i}>{n.text}</Fragment>;
      case "br":
        return <br key={i} />;
      case "bold":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener nofollow ugc" className="text-accent underline">
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

/** A knowledge-base article body: a small Markdown subset built as React elements. Never HTML strings. */
export function KbBody({ body }: { body: string }) {
  return (
    <div className="min-w-0 space-y-4 break-words">
      {parseMarkdown(body).map((b, i) => {
        if (b.type === "paragraph") return <p key={i}>{renderInline(b.children)}</p>;
        const items = b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
        return b.type === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-6">
            {items}
          </ul>
        ) : (
          <ol key={i} className="list-decimal space-y-1 pl-6">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
