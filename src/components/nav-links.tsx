"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ links }: { links: { href: string; label: string; badge?: number }[] }) {
  const pathname = usePathname();
  if (links.length === 0) return null;
  // The longest matching link is the current one, so /desk/kb marks "KB editor" and not "Desk" too.
  const current = links
    .filter((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))
    .reduce<string | null>((best, l) => (best === null || l.href.length > best.length ? l.href : best), null);
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5">
      {links.map((l) => {
        const active = l.href === current;
        const unread = l.badge !== undefined && l.badge > 0 ? l.badge : 0;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            aria-label={unread > 0 ? `${l.label}, ${unread} unread` : undefined}
            className={`inline-flex min-h-11 items-center gap-1.5 border-b-2 text-sm font-semibold ${
              active ? "border-accent text-accent" : "border-transparent text-foreground hover:text-accent"
            }`}
          >
            <span>{l.label}</span>
            {unread > 0 && (
              <span
                aria-hidden
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-foreground"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
