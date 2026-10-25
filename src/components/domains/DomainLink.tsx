"use client";

import { usePathname, useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

export type PanelTab = "overview" | "inboxes" | "stats" | "history";

/**
 * A domain name that opens the domain panel over the page you are on, instead
 * of taking you to another page. Other settings in the address (the tab, the
 * client filter) stay as they are.
 */
export function DomainLink({ id, tab, className, title, children }: {
  id: string; tab?: PanelTab; className?: string; title?: string; children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const href = `${pathname}?d=${id}${tab ? `&tab=${tab}` : ""}`;
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let "open in a new tab" work as usual.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = new URLSearchParams(window.location.search);
    p.set("d", id);
    if (tab) p.set("tab", tab); else p.delete("tab");
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  };
  return <a href={href} className={className} title={title} onClick={open}>{children}</a>;
}
