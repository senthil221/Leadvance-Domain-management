"use client";

import { Menu, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, ViewTransition, type ReactNode } from "react";
import { brand } from "@/lib/brand";
import { ThemeToggle } from "../ThemeToggle";
import { BrandMark } from "./BrandMark";
import { CommandPalette } from "./CommandPalette";
import { NAV_ITEMS } from "./nav";

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

export function AppShell({ nav, user, children }: { nav: ReactNode; user: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const pendingG = useRef(0);

  // Close the mobile drawer whenever the page changes.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setNavOpen(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      // "g" then a letter jumps to a page, like Linear and GitHub.
      if (e.key === "g") {
        pendingG.current = Date.now();
        return;
      }
      if (Date.now() - pendingG.current < 900) {
        const item = NAV_ITEMS.find((n) => n.key === e.key);
        pendingG.current = 0;
        if (item) {
          e.preventDefault();
          router.push(item.href);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="shell" data-nav-open={navOpen}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark size={12} />
          {brand.name}
        </div>
        <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)}>
          <Search size={14} strokeWidth={1.5} />
          Search
          <kbd className="kbd">⌘K</kbd>
        </button>
        {nav}
        <div className="sidebar-foot">
          {user}
          <ThemeToggle />
        </div>
      </aside>
      {navOpen ? <div className="overlay lg:hidden" style={{ zIndex: 55 }} onClick={() => setNavOpen(false)} /> : null}
      <main className="main-panel">
        <div className="mobile-bar">
          <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <Menu size={18} strokeWidth={1.5} />
          </button>
          <span className="font-semibold">{brand.name}</span>
          <button type="button" className="icon-btn ml-auto" aria-label="Search" onClick={() => setPaletteOpen(true)}>
            <Search size={16} strokeWidth={1.5} />
          </button>
        </div>
        <ViewTransition key={pathname} name="workspace-content">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </ViewTransition>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
