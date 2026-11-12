"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { groupOf, isActive } from "./nav";

/** The pages behind the current sidebar entry, as tabs in the page header. */
export function SectionTabs() {
  const pathname = usePathname();
  const group = groupOf(pathname);
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen the row scrolls: keep the current tab in sight.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  if (!group || group.pages.length < 2) return null;
  return (
    <nav ref={nav} className="section-tabs" aria-label={group.label}>
      {group.pages.map((p) => (
        <Link key={p.href} href={p.href} aria-current={isActive(pathname, p.href) ? "page" : undefined}>{p.label}</Link>
      ))}
    </nav>
  );
}
