import { Activity, ArrowLeftRight, BarChart3, CalendarClock, CircleCheck, ClipboardCheck, Columns2, Globe, Inbox, LayoutGrid, MailX, MessageSquareText, Settings2, Tags, Users, Wrench, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; key: string };
export type NavGroup = NavItem & { pages: NavItem[] };

// Every page. `key` is the second key of the "g then key" shortcut, and the
// command palette lists them all.
export const PAGES = {
  overview: { href: "/", label: "Overview", icon: LayoutGrid, key: "o" },
  clients: { href: "/clients", label: "Clients", icon: Users, key: "l" },
  fix: { href: "/fix", label: "Fix queue", icon: Wrench, key: "x" },
  inventory: { href: "/inventory", label: "Domains", icon: Globe, key: "d" },
  replacements: { href: "/replacements", label: "Replacements", icon: ArrowLeftRight, key: "r" },
  freeDomains: { href: "/free-domains", label: "Free domains", icon: CircleCheck, key: "f" },
  expiring: { href: "/expiring", label: "Expiring", icon: CalendarClock, key: "e" },
  inboxes: { href: "/inboxes", label: "Smartlead", icon: Inbox, key: "i" },
  tags: { href: "/tags", label: "Tags", icon: Tags, key: "m" },
  review: { href: "/review", label: "Weekly review", icon: ClipboardCheck, key: "w" },
  compare: { href: "/compare", label: "Compare", icon: Columns2, key: "c" },
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
      { ...P.fix, pages: [] },
      { ...P.clients, pages: [] },
      { ...P.inboxes, pages: [{ ...P.inboxes, label: "Inboxes" }, P.tags] },
      { ...P.inventory, pages: [{ ...P.inventory, label: "Inventory" }, P.replacements, P.freeDomains, P.expiring] },
      { ...P.review, label: "Performance", icon: BarChart3, pages: [P.review, P.compare, P.stats, P.replies, P.bounces] },
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
