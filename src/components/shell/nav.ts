import { Activity, ArrowLeftRight, Boxes, Globe, Inbox, LayoutGrid, MessageSquareText, Settings2, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; key: string };

// `key` is the second key of the "g then key" shortcut.
export const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: LayoutGrid, key: "o" },
      { href: "/domains", label: "Domains", icon: Globe, key: "d" },
      { href: "/replacements", label: "Replacements", icon: ArrowLeftRight, key: "r" },
      { href: "/health", label: "Health", icon: Activity, key: "h" },
      { href: "/inboxes", label: "Inboxes", icon: Inbox, key: "i" },
      { href: "/activity", label: "Replies", icon: MessageSquareText, key: "a" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/inventory", label: "Inventory", icon: Boxes, key: "v" },
      { href: "/settings", label: "Settings", icon: Settings2, key: "s" },
    ],
  },
];

export const NAV_ITEMS = NAV.flatMap((s) => s.items);

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
