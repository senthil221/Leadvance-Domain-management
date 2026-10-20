"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { groupOf, NAV } from "./nav";

export type NavBadges = Partial<Record<string, { value: number; warning?: boolean }>>;

export function NavLinks({ badges = {} }: { badges?: NavBadges }) {
  const pathname = usePathname();
  const current = groupOf(pathname);
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((section) => (
        <div key={section.label} className="nav-section">
          <p className="nav-label">{section.label}</p>
          {section.items.map(({ href, label, icon: Icon, pages }) => {
            // A grouped entry shows the most pressing badge of its pages.
            const badge = [href, ...pages.map((x) => x.href)].map((h) => badges[h]).find((b) => b && b.value > 0 && b.warning) ?? badges[href];
            return (
              <Link key={href} href={href} className="nav-link" aria-current={current?.href === href ? "page" : undefined}>
                <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{label}</span>
                {badge && badge.value > 0 ? (
                  <span className={`nav-count${badge.warning ? " is-warning" : ""}`}>{badge.value}</span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
