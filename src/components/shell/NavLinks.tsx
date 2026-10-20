"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, NAV } from "./nav";

export type NavBadges = Partial<Record<string, { value: number; warning?: boolean }>>;

export function NavLinks({ badges = {} }: { badges?: NavBadges }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((section) => (
        <div key={section.label} className="nav-section">
          <p className="nav-label">{section.label}</p>
          {section.items.map(({ href, label, icon: Icon }) => {
            const badge = badges[href];
            return (
              <Link key={href} href={href} className="nav-link" aria-current={isActive(pathname, href) ? "page" : undefined}>
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
