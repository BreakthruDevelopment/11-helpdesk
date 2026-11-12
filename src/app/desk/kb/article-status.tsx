import { StatusBadge } from "@/components/ui";
import type { AgentArticle } from "@/lib/kb";

export function ArticleStatus({ status }: { status: AgentArticle["status"] }) {
  return status === "published" ? <StatusBadge status="live" label="Published" /> : <StatusBadge status="not-started" label="Draft" />;
}
