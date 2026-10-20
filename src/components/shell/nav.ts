import { Activity, ArrowLeftRight, BarChart3, Boxes, Globe, Inbox, LayoutGrid, MessageSquareText, Settings2, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; key: string };
export type NavGroup = NavItem & { pages: NavItem[] };

// Every page. `key` is the second key of the "g then key" shortcut, and the
// command palette lists them all.
export const PAGES = {
  overview: { href: "/", label: "Overview", icon: LayoutGrid, key: "o" },
  domains: { href: "/domains", label: "Domains", icon: Globe, key: "d" },
  inventory: { href: "/inventory", label: "Inventory", icon: Boxes, key: "v" },
  replacements: { href: "/replacements", label: "Replacements", icon: ArrowLeftRight, key: "r" },
  inboxes: { href: "/inboxes", label: "Inboxes", icon: Inbox, key: "i" },
  stats: { href: "/stats", label: "Stats", icon: BarChart3, key: "t" },
  replies: { href: "/activity", label: "Replies", icon: MessageSquareText, key: "a" },
  health: { href: "/health", label: "Health rules", icon: Activity, key: "h" },
  settings: { href: "/settings", label: "Settings", icon: Settings2, key: "s" },
} satisfies Record<string, NavItem>;

const P = PAGES;

// The sidebar: five places, related pages grouped behind one entry and
// reached through the tabs in the page header.
export const NAV: { label: string; items: NavGroup[] }[] = [
  {
    label: "Workspace",
    items: [
      { ...P.overview, pages: [] },
      { ...P.domains, pages: [{ ...P.domains, label: "Performance" }, P.inventory, P.replacements] },
      { ...P.inboxes, pages: [] },
      { ...P.stats, label: "Performance", pages: [P.stats, P.replies, P.health] },
    ],
  },
  { label: "Manage", items: [{ ...P.settings, pages: [] }] },
];

export const NAV_ITEMS: NavItem[] = Object.values(PAGES);

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

/** The sidebar entry a page belongs to. */
export function groupOf(pathname: string): NavGroup | undefined {
  return NAV.flatMap((s) => s.items).find((g) => isActive(pathname, g.href) || g.pages.some((p) => isActive(pathname, p.href)));
}
