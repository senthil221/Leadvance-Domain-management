import { Activity, ArrowLeftRight, BarChart3, ClipboardCheck, Globe, Inbox, LayoutGrid, MailX, MessageSquareText, Settings2, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; key: string };
export type NavGroup = NavItem & { pages: NavItem[] };

// Every page. `key` is the second key of the "g then key" shortcut, and the
// command palette lists them all.
export const PAGES = {
  overview: { href: "/", label: "Overview", icon: LayoutGrid, key: "o" },
  inventory: { href: "/inventory", label: "Domains", icon: Globe, key: "d" },
  replacements: { href: "/replacements", label: "Replacements", icon: ArrowLeftRight, key: "r" },
  inboxes: { href: "/inboxes", label: "Smartlead", icon: Inbox, key: "i" },
  review: { href: "/review", label: "Weekly review", icon: ClipboardCheck, key: "w" },
  stats: { href: "/stats", label: "Stats", icon: BarChart3, key: "t" },
  replies: { href: "/activity", label: "Replies", icon: MessageSquareText, key: "a" },
  bounces: { href: "/bounces", label: "Bounces", icon: MailX, key: "b" },
  health: { href: "/health", label: "Health rules", icon: Activity, key: "h" },
  settings: { href: "/settings", label: "Settings", icon: Settings2, key: "s" },
} satisfies Record<string, NavItem>;

const P = PAGES;

// The sidebar: Overview, Smartlead (the sending setup), Domains (what you own)
// and Performance (what the emails did). Related pages sit behind one entry
// and are reached through the tabs in the page header.
export const NAV: { label: string; items: NavGroup[] }[] = [
  {
    label: "Workspace",
    items: [
      { ...P.overview, pages: [] },
      { ...P.inboxes, pages: [] },
      { ...P.inventory, pages: [{ ...P.inventory, label: "Inventory" }, P.replacements] },
      { ...P.review, label: "Performance", icon: BarChart3, pages: [P.review, P.stats, P.replies, P.bounces] },
    ],
  },
  { label: "Manage", items: [{ ...P.settings, pages: [P.settings, P.health] }] },
];

export const NAV_ITEMS: NavItem[] = Object.values(PAGES);

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

/** The sidebar entry a page belongs to. */
export function groupOf(pathname: string): NavGroup | undefined {
  return NAV.flatMap((s) => s.items).find((g) => isActive(pathname, g.href) || g.pages.some((p) => isActive(pathname, p.href)));
}
