"use client";

import { ArrowLeftRight, ChevronDown, Copy, Flame, ChevronRight, ChevronsDownUp, ChevronsUpDown, Inbox, Info, PlugZap, Search, Settings2, ShieldCheck, Shuffle, Tag, Tags as TagsIcon, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";
import { markInboxes, reconnectInboxes, saveInboxLimit, startWarmupNow, validateDns } from "@/app/actions";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ColumnsMenu, useColumns, type ColumnDef } from "@/components/Columns";
import { SortTh } from "@/components/SortTh";
import { DomainLink } from "@/components/domains/DomainLink";
import { MARK_CHOICES, MARK_TAGS, isMark, normTag } from "@/lib/tag-map";
import { warmupProgress } from "@/lib/warmup-program";
import { ReplaceDialog } from "@/components/domains/ReplaceDialog";
import { copyDomains, copyText, keepTextUnselected } from "@/components/table-tools";
import { useSticky } from "@/lib/sticky";
import { ClientCell, Empty, Rep, StatusDot, TagList } from "@/components/ui";
import { InboxSettingsDialog } from "./InboxSettingsDialog";
import { WarmingButtons } from "@/components/domains/DomainBulk";
import { MoveToTagDialog } from "./MoveToTagDialog";
import { PlansCard } from "./PlansCard";
import { ageLabel, ago, int } from "@/lib/format";
import type { ClientRow, InboxListRow, OrderState, PlanRow } from "@/lib/queries";
import { DOMAIN_STATUSES, canReplace, isStepFinished, type DomainStatus } from "@/lib/status";
import { Select } from "@/components/Select";
import { setupLabel, type SetupRow } from "@/lib/replacement-setups";

// Six views of the sending setup. Active and Disconnected list inboxes under
// their client and domain; the others list one line per domain.
// Domains in the warm-up programme (enrolled, not yet moved to a tag) live under
// Warming up only, and so do new domains that haven't started it yet (`fresh`).
// Cleanup lists domains with too many inboxes or several sender names (`crowded`),
// usually old inboxes left behind when a domain was renamed.
const warmingUp = (i: InboxListRow) => i.domainWarmupStartedAt != null && i.domainWarmupDoneAt == null;
// Replacement domains still being set up (`setup`) are on Warming up too, from
// the day they're picked, even before any of their inboxes reach Smartlead.
type Sets = { fresh: Set<string>; crowded: Set<string>; setup: Map<string, SetupRow> };
type Match = (i: InboxListRow, s: Sets) => boolean;
const TABS: readonly { key: "active" | "warming" | "attention" | "cleanup" | "disconnected" | "all"; label: string; match: Match }[] = [
  { key: "active", label: "Active", match: (i, s) => i.status === "connected" && i.domainStatus === "active" && !warmingUp(i) && !s.fresh.has(i.domainId) && !s.setup.has(i.domainId) },
  { key: "warming", label: "Warming up", match: (i, s) => (warmingUp(i) || s.fresh.has(i.domainId) || s.setup.has(i.domainId)) && i.status !== "removed" },
  { key: "attention", label: "Needs attention", match: (i, s) => (i.domainStatus === "active" || i.domainStatus === "warming") && !warmingUp(i) && !s.fresh.has(i.domainId) && !s.setup.has(i.domainId) },
  { key: "cleanup", label: "Cleanup", match: (i, s) => s.crowded.has(i.domainId) && i.status !== "removed" },
  { key: "disconnected", label: "Disconnected", match: (i) => i.status === "disconnected" },
  { key: "all", label: "All domains", match: () => true },
];

const senderKey = (n: string | null) => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Domains with more inboxes than `limit`, or inboxes under more than one sender name. */
function crowdedDomains(inboxes: InboxListRow[], limit: number) {
  const ids = new Set<string>();
  for (const g of group(inboxes.filter((i) => i.status !== "removed"))) {
    if (g.count > limit || g.senders.length > 1) ids.add(g.domainId);
  }
  return ids;
}

/**
 * New domains that haven't started warming: connected, at most `maxAgeDays`
 * old and not part of a replacement (those carry New already). A client or a
 * client tag doesn't make a domain ready to send; it still warms up first.
 */
function freshDomains(inboxes: InboxListRow[], maxAgeDays: number) {
  const ids = new Set<string>();
  for (const g of group(inboxes.filter((i) => i.status === "connected"))) {
    const f = g.inboxes[0];
    if (f.domainWarmupStartedAt || g.ageDays == null || g.ageDays > maxAgeDays) continue;
    if (f.domainStatus !== "active" && f.domainStatus !== "warming") continue;
    if (f.domainTags.some((t) => t.toLowerCase() === "new")) continue;
    ids.add(g.domainId);
  }
  return ids;
}
/**
 * Shown on Warming up even when the domain is out of scope elsewhere: a
 * replacement's new domain can still be filed under the old name at the inbox
 * provider, yet it's warming and belongs here.
 */
const onWarmingTab = (i: InboxListRow, s: Sets) => s.setup.has(i.domainId) || warmingUp(i);
type TabKey = (typeof TABS)[number]["key"];
type Grouping = "none" | "client" | "tags";
const GROUPING_KEY = "inboxes:grouping";
const tabOf = (v: string | null): TabKey => (TABS.find((t) => t.key === v)?.key ?? "active");
const FLAT: TabKey[] = ["warming", "attention", "cleanup", "all"];
const tabMatch = (k: TabKey, sets: Sets) => (i: InboxListRow) => TABS.find((t) => t.key === k)!.match(i, sets);

/** Why a domain is on the Needs attention list: everything wrong with its sending setup. */
type Reason = { label: string; tone: "danger" | "warning" };
function reasonsOf(g: Group): Reason[] {
  const r: Reason[] = [];
  if (g.disconnected) r.push({ label: g.count > 1 ? `${g.disconnected} disconnected` : "Disconnected", tone: "danger" });
  if (g.blocked) r.push({ label: g.count > 1 ? `${g.blocked} warmup blocked` : "Warmup blocked", tone: "danger" });
  if (g.lowRep) r.push({ label: g.count > 1 ? `${g.lowRep} reputation under 90` : "Reputation under 90", tone: "warning" });
  if (g.paused) r.push({ label: g.count > 1 ? `${g.paused} warmup off` : "Warmup off", tone: "warning" });
  if (g.dns.state === "nozone") r.push({ label: "No DNS zone", tone: "danger" });
  else if (g.dns.state === "missing") r.push({ label: `DNS: ${g.dns.missing.join(", ")}`, tone: "warning" });
  if ((g.bl ?? 0) > 0) r.push({ label: `Blacklisted (${g.bl})`, tone: "danger" });
  if (g.alerts) r.push({ label: g.alerts === 1 ? "Health alert" : `${g.alerts} health alerts`, tone: "warning" });
  if (g.order && g.order !== "active") r.push({ label: ORDER_META[g.order].label, tone: ORDER_META[g.order].tone });
  return r;
}

const ORDER_META: Record<Exclude<OrderState, "active">, { label: string; tone: "danger" | "warning"; hint: string }> = {
  cancelled: { label: "Order cancelled", tone: "danger", hint: "The order is cancelled at the provider (NPC in Hypertide's API): the inboxes are going or gone" },
  pending: { label: "Order not done", tone: "warning", hint: "The order isn't done at the provider yet" },
  gone: { label: "Order ended", tone: "danger", hint: "The provider no longer lists this domain's order: it was removed or moved to another domain" },
  replaced: { label: "Replaced at Hypertide", tone: "danger", hint: "Hypertide moved this domain's order onto another domain" },
  missing: { label: "No order", tone: "danger", hint: "No live order for this domain at the provider" },
};

/**
 * Why an active domain doesn't count as Active: its order at Hypertide or
 * Icemail isn't active, or some of its inboxes are disconnected in Smartlead.
 * Null when it really is active, or isn't meant to be.
 */
function notLive(g: Group): { label: string; tone: "danger" | "warning"; hint: string } | null {
  if (g.status !== "active") return null;
  const where = g.provider ? ` (${g.provider}${g.orderStatus ? `: ${g.orderStatus}` : ""})` : "";
  if (g.order && g.order !== "active") return { ...ORDER_META[g.order], hint: `${ORDER_META[g.order].hint}${where}` };
  const { inboxes: n, disconnected: off } = g.all;
  if (off) {
    return off === n
      ? { label: "Disconnected", tone: "danger", hint: "Every inbox is disconnected in Smartlead" }
      : { label: `${off} of ${n} disconnected`, tone: "warning", hint: "Some inboxes are disconnected in Smartlead" };
  }
  return null;
}

/** The domain's status, Active only when the order is active and every inbox is connected. */
function DomainState({ g }: { g: Group }) {
  const p = notLive(g);
  if (!p) return <StatusDot status={g.status} />;
  return <span className={`status-dot tone-${p.tone}`} title={`Active in the app, but: ${p.hint}`}>{p.label}</span>;
}

type Group = {
  domainId: string; domain: string; status: DomainStatus; clientName: string | null; clientHue: number | null;
  inboxes: InboxListRow[];
  count: number; warmupOff: number; avgWarmup: number | null; avgLimit: number | null; capacity: number;
  avgRep: number | null; minRep: number | null; lowRep: number; campaigns: number;
  /** Inboxes in a running campaign, and in a paused one only; the campaigns by name. */
  camp: { live: number; paused: number; liveNames: string[]; pausedNames: string[] };
  sent7: number; replies7: number; human7: number; bounces7: number;
  sentToday: number; avgWait: number | null; pending: number; tags: string[]; esp: string | null;
  domainTags: string[]; graceDaysLeft: number | null; alerts: number;
  warm: { day: number; days: number; ready: boolean; left: number; pct: number } | null;
  ageDays: number | null; dns: Dns; bl: number | null; blListings: string[]; blocked: number; paused: number; disconnected: number;
  order: OrderState | null; orderStatus: string | null; provider: string | null;
  /** Every inbox on the domain, not just those the view shows. */
  all: { inboxes: number; disconnected: number };
  /** Inboxes by sender name, most first; `added` is the earliest inbox's age in days. */
  senders: { name: string; ids: string[]; added: number | null }[];
  /** A replacement domain still being set up, on Warming up. */
  setup: SetupRow | null;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

function group(rows: InboxListRow[]): Group[] {
  const map = new Map<string, InboxListRow[]>();
  for (const r of rows) map.set(r.domainId, [...(map.get(r.domainId) ?? []), r]);
  return [...map.values()].map((list) => {
    const f = list[0];
    const reps = list.map((i) => i.warmupReputation).filter((x): x is number => x != null);
    return {
      domainId: f.domainId, domain: f.domain, status: f.domainStatus, clientName: f.clientName, clientHue: f.clientHue,
      inboxes: list,
      count: list.length,
      warmupOff: list.filter((i) => !i.warmupEnabled).length,
      avgWarmup: avg(list.filter((i) => i.warmupEnabled && i.warmupPerDay != null).map((i) => i.warmupPerDay!)),
      avgLimit: avg(list.filter((i) => i.dailyLimit != null).map((i) => i.dailyLimit!)),
      capacity: list.reduce((a, i) => a + (i.dailyLimit ?? 0), 0),
      avgRep: avg(reps),
      minRep: reps.length ? Math.min(...reps) : null,
      lowRep: reps.filter((r) => r < 90).length,
      campaigns: Math.max(0, ...list.map((i) => i.campaigns)),
      camp: {
        live: list.filter((i) => i.liveCampaigns.length).length,
        paused: list.filter((i) => !i.liveCampaigns.length && i.pausedCampaigns.length).length,
        liveNames: [...new Set(list.flatMap((i) => i.liveCampaigns))].sort(),
        pausedNames: [...new Set(list.flatMap((i) => i.pausedCampaigns))].sort(),
      },
      sent7: list.reduce((a, i) => a + i.sent7, 0),
      replies7: list.reduce((a, i) => a + i.replies7, 0),
      human7: list.reduce((a, i) => a + i.human7, 0),
      bounces7: list.reduce((a, i) => a + i.bounces7, 0),
      sentToday: list.reduce((a, i) => a + (i.dailySent ?? 0), 0),
      avgWait: avg(list.filter((i) => i.minWaitMins != null).map((i) => i.minWaitMins!)),
      pending: list.filter((i) => i.change?.status === "pending" || i.change?.status === "running").length,
      tags: [...new Set(list.flatMap((i) => i.smartleadTags))],
      domainTags: f.domainTags.filter((t) => MARK_TAGS.includes(t.toLowerCase())),
      graceDaysLeft: f.domainGraceDaysLeft,
      alerts: f.domainAlerts,
      warm: f.domainWarmupDoneAt ? null : warmupProgress(f.domainWarmupStartedAt, f.domainWarmupDays),
      ageDays: (() => {
        // Age counts from the first inbox added to Smartlead; registration only when no inbox has a date.
        const t = list.map((i) => (i.smartleadCreatedAt ? new Date(i.smartleadCreatedAt).getTime() : NaN)).filter((x) => !Number.isNaN(x));
        const born = t.length ? Math.min(...t) : f.domainBornAt ? new Date(f.domainBornAt).getTime() : null;
        return born == null ? null : Math.floor((Date.now() - born) / 86_400_000);
      })(),
      dns: dnsOf(f),
      bl: f.blDomain == null && f.blIp == null ? null : (f.blDomain ?? 0) + (f.blIp ?? 0),
      blListings: (f.blListings ?? []).map((l) => `${l.list}${l.kind === "ip" ? " (IP)" : ""}`),
      blocked: list.filter((i) => warmupOf(i) === "blocked").length,
      paused: list.filter((i) => warmupOf(i) === "paused").length,
      disconnected: list.filter((i) => i.status === "disconnected").length,
      order: f.domainOrder, orderStatus: f.domainOrderStatus, provider: f.domainProvider,
      all: { inboxes: f.domainInboxes, disconnected: f.domainDisconnected },
      senders: (() => {
        const by = new Map<string, { name: string; ids: string[]; born: number }>();
        for (const i of list) {
          const k = senderKey(i.senderName);
          const e = by.get(k) ?? { name: i.senderName?.trim() || "No sender name", ids: [], born: Infinity };
          e.ids.push(i.id);
          if (i.smartleadCreatedAt) e.born = Math.min(e.born, new Date(i.smartleadCreatedAt).getTime());
          by.set(k, e);
        }
        return [...by.values()].sort((a, b) => b.ids.length - a.ids.length)
          .map((e) => ({ name: e.name, ids: e.ids, added: Number.isFinite(e.born) ? Math.floor((Date.now() - e.born) / 86_400_000) : null }));
      })(),
      esp: (() => { const t = [...new Set(list.map((i) => i.providerType).filter(Boolean))]; return t.length === 1 ? t[0] : t.length ? "MIXED" : null; })(),
      setup: null,
    };
  });
}

/** A replacement domain with no inbox in Smartlead yet: one row on Warming up, nothing to add up. */
function setupGroup(s: SetupRow): Group {
  const checks: [string, boolean | null][] = [["SPF", s.dnsSpf], ["DKIM", s.dnsDkim], ["DMARC", s.dnsDmarc], ["MX", s.dnsMx]];
  const missing = checks.filter(([, v]) => v === false).map(([k]) => k);
  const dns: Dns = s.nsAnswering === false ? { state: "nozone", missing: [], checks: [] }
    : checks.every(([, v]) => v == null) ? { state: "unknown", missing: [], checks } : { state: missing.length ? "missing" : "ok", missing, checks };
  return {
    domainId: s.domainId, domain: s.domain, status: s.status, clientName: s.clientName, clientHue: s.clientHue,
    inboxes: [], count: 0, warmupOff: 0, avgWarmup: null, avgLimit: null, capacity: 0, avgRep: null, minRep: null, lowRep: 0, campaigns: 0, camp: { live: 0, paused: 0, liveNames: [], pausedNames: [] },
    sent7: 0, replies7: 0, human7: 0, bounces7: 0, sentToday: 0, avgWait: null, pending: 0, tags: [], esp: null,
    domainTags: s.tags.filter((t) => MARK_TAGS.includes(t.toLowerCase())), graceDaysLeft: null, alerts: 0, warm: null, ageDays: null, dns,
    bl: null, blListings: [], blocked: 0, paused: 0, disconnected: 0, order: null, orderStatus: null, provider: null,
    all: { inboxes: 0, disconnected: 0 }, senders: [], setup: s,
  };
}

/**
 * Domains rolled up into one row with the same columns: sums for counts,
 * averages over inboxes for rates, and how many domains have a problem. Used
 * for a client and for a tag inside a client.
 */
type ClientGroup = Group & {
  key: string; domains: Group[]; dnsBad: number; listed: number; tagGroups: ClientGroup[] | null;
  /** Active domains, and those of them that really are: order active, every inbox connected. */
  activeDomains: number; liveDomains: number;
  /** Domains with inboxes and none in a running campaign, and those with only some in one. */
  campFree: string[]; campPartial: number;
};
function roll(key: string, label: string, clientName: string | null, domains: Group[]): ClientGroup {
  const list = domains.flatMap((d) => d.inboxes);
  const [s] = group(list.map((i) => ({ ...i, domainId: `roll:${key}` })));
  const missing = [...new Set(domains.flatMap((d) => d.dns.missing))];
  return {
    ...s,
    key,
    domains,
    domainId: `roll:${key}`,
    domain: label,
    clientName,
    clientHue: domains[0].clientHue,
    inboxes: list,
    ageDays: null,
    domainTags: [],
    graceDaysLeft: null,
    warm: null,
    campaigns: Math.max(0, ...domains.map((d) => d.campaigns)),
    dns: { state: domains.some((d) => d.dns.state === "nozone") ? "nozone" : missing.length ? "missing" : domains.every((d) => d.dns.state === "unknown") ? "unknown" : "ok", missing, checks: [] },
    dnsBad: domains.filter((d) => d.dns.state === "missing" || d.dns.state === "nozone").length,
    bl: domains.some((d) => d.bl != null) ? domains.reduce((a, d) => a + (d.bl ?? 0), 0) : null,
    listed: domains.filter((d) => (d.bl ?? 0) > 0).length,
    blListings: [...new Set(domains.flatMap((d) => (d.bl ? [d.domain] : [])))],
    order: null, orderStatus: null, provider: null,
    all: { inboxes: domains.reduce((a, d) => a + d.all.inboxes, 0), disconnected: domains.reduce((a, d) => a + d.all.disconnected, 0) },
    activeDomains: domains.filter((d) => d.status === "active").length,
    liveDomains: domains.filter((d) => d.status === "active" && !notLive(d)).length,
    campFree: domains.filter((d) => d.count > 0 && !d.camp.live).map((d) => d.domain),
    campPartial: domains.filter((d) => d.camp.live > 0 && d.camp.live < d.count).length,
    tagGroups: null,
  };
}

/**
 * The tags inside a client, each with its own domains and only the inboxes that
 * carry that tag. Null when the client has just one tag named like itself (or
 * none), so those clients keep going straight from client to domain.
 */
function tagGroupsOf(c: ClientGroup): ClientGroup[] | null {
  const byTag = new Map<string, { shown: string; inboxes: InboxListRow[] }>();
  for (const i of c.inboxes) {
    const tags = i.smartleadTags.filter((t) => t.trim() && !MARK_TAGS.includes(t.trim().toLowerCase()));
    for (const t of tags.length ? tags : [""]) {
      const k = normTag(t);
      const e = byTag.get(k) ?? { shown: t.trim(), inboxes: [] };
      e.inboxes.push(i);
      byTag.set(k, e);
    }
  }
  const keys = [...byTag.keys()];
  if (keys.length === 0 || (keys.length === 1 && (keys[0] === "" || keys[0] === normTag(c.clientName ?? "")))) return null;
  return [...byTag.entries()]
    .map(([k, e]) => roll(`${c.key}|${k}`, e.shown || "No tag", c.clientName, group(e.inboxes)))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function byClient(groups: Group[]): ClientGroup[] {
  const map = new Map<string, Group[]>();
  for (const g of groups) map.set(g.clientName ?? "", [...(map.get(g.clientName ?? "") ?? []), g]);
  return [...map.entries()].map(([key, domains]) => {
    const c = roll(key, key || "No client", key || null, domains);
    return { ...c, tagGroups: tagGroupsOf(c) };
  });
}

type SortKey = "progress" | "reasons" | "senders" | "domain" | "status" | "client" | "esp" | "tags" | "age" | "dnsMissing" | "warmupState" | "blacklist" | "connection" | "count" | "avgWarmup" | "avgLimit" | "capacity" | "sentToday" | "avgWait" | "avgRep" | "campaigns" | "sent7" | "replyRate" | "bounceRate";
const sortValue = (g: Group, k: SortKey): string | number | null => {
  switch (k) {
    // Within a status, domains that aren't really live come after those that are.
    case "status": return DOMAIN_STATUSES.indexOf(g.status) * 10 + (notLive(g) ? (notLive(g)!.tone === "danger" ? 2 : 1) : 0);
    case "progress": return g.warm ? 100 + g.warm.pct : stageOf(g) === "ready" ? 1 : 0;
    case "reasons": return reasonsOf(g).length;
    case "senders": return g.senders.length;
    case "client": return g.clientName?.toLowerCase() ?? null;
    case "esp": return g.esp;
    case "tags": return g.tags.join(", ").toLowerCase() || null;
    case "age": return g.ageDays;
    case "dnsMissing": return g.dns.state === "unknown" ? null : g.dns.state === "nozone" ? 9 : g.dns.missing.length;
    case "warmupState": return g.blocked * 100 + g.paused;
    case "blacklist": return g.bl;
    case "connection": return g.disconnected;
    case "campaigns": return g.count ? g.camp.live / g.count : null;
    case "replyRate": return rate(g.replies7, g.sent7);
    case "bounceRate": return rate(g.bounces7, g.sent7);
    default: return g[k];
  }
};

/** The same columns for one inbox, so an open domain's inboxes follow the table's sort. */
const inboxValue = (i: InboxListRow, k: SortKey): string | number | null => {
  switch (k) {
    case "client": return i.senderName?.toLowerCase() ?? null;
    case "esp": return i.providerType;
    case "tags": return i.smartleadTags.join(", ").toLowerCase() || null;
    case "age": return i.smartleadCreatedAt ? -new Date(i.smartleadCreatedAt).getTime() : null;
    case "warmupState": { const w = warmupOf(i); return w === "blocked" ? 100 : w === "paused" ? 1 : 0; }
    case "connection": return i.status === "disconnected" ? 1 : 0;
    case "avgWarmup": return i.warmupEnabled ? i.warmupPerDay : null;
    case "avgLimit": case "capacity": return i.dailyLimit;
    case "sentToday": return i.dailySent;
    case "avgWait": return i.minWaitMins;
    case "avgRep": return i.warmupReputation;
    case "campaigns": return i.liveCampaigns.length ? i.liveCampaigns.length : i.pausedCampaigns.length ? 0.5 : 0;
    case "sent7": return i.sent7;
    case "replyRate": return rate(i.replies7, i.sent7);
    case "bounceRate": return rate(i.bounces7, i.sent7);
    default: return null;
  }
};
const byValue = <T,>(value: (x: T) => string | number | null, tie: (a: T, b: T) => number, dir: 1 | -1) => (a: T, b: T) => {
  const x = value(a), y = value(b);
  if (x === y) return tie(a, b);
  if (x === null) return 1;
  if (y === null) return -1;
  return (x < y ? -1 : 1) * dir;
};

const n0 = (v: number | null, digits = 0) => (v == null ? <span className="zero">—</span> : v.toFixed(digits));

const COLUMNS: ColumnDef[] = [
  { key: "status", label: "Status" }, { key: "client", label: "Client / sender" }, { key: "esp", label: "ESP" }, { key: "tags", label: "Smartlead tags" },
  { key: "count", label: "Inboxes" }, { key: "warmup", label: "Warmup" }, { key: "limit", label: "Limit", hidden: true },
  { key: "capacity", label: "Per day" }, { key: "today", label: "Sent today" }, { key: "gap", label: "Gap", hidden: true },
  { key: "rep", label: "Reputation" },
  { key: "age", label: "Domain age" }, { key: "dns", label: "DNS" }, { key: "warmupState", label: "Warmup status" },
  { key: "blacklist", label: "Blacklist" }, { key: "campaigns", label: "Campaigns" }, { key: "connection", label: "Connection" },
];

const espLabel = (t: string) => (t === "OUTLOOK" ? "Outlook" : t === "GMAIL" || t === "GOOGLE" ? "Google" : t === "MIXED" ? "Mixed" : t === "SMTP" ? "SMTP" : t.charAt(0) + t.slice(1).toLowerCase());
function EspBadge({ type }: { type: string }) {
  const tone = type === "OUTLOOK" ? "tone-info" : type === "GMAIL" || type === "GOOGLE" ? "tone-success" : "";
  return <span className={`badge ${tone}`}>{espLabel(type)}</span>;
}
function Tags({ tags, graceDaysLeft = null }: { tags: string[]; graceDaysLeft?: number | null }) {
  if (!tags.length) return <span className="zero">—</span>;
  return <span className="flex items-center gap-1"><TagList tags={tags} graceDaysLeft={graceDaysLeft} /></span>;
}

type Dns = { state: "ok" | "missing" | "nozone" | "unknown"; missing: string[]; checks: [string, boolean | null][] };
function dnsOf(i: InboxListRow): Dns {
  if (i.nsAnswering === false) return { state: "nozone", missing: [], checks: [] };
  const checks: [string, boolean | null][] = [["SPF", i.dnsSpf], ["DKIM", i.dnsDkim], ["DMARC", i.dnsDmarc], ["MX", i.dnsMx]];
  if (checks.every(([, v]) => v == null)) return { state: "unknown", missing: [], checks };
  const missing = checks.filter(([, v]) => v === false).map(([k]) => k);
  return { state: missing.length ? "missing" : "ok", missing, checks };
}
const warmupOf = (i: InboxListRow) => (i.warmupBlockedReason || /BLOCK/i.test(i.warmupStatus ?? "") ? "blocked" : i.warmupEnabled !== true || /INACTIVE|PAUSE/i.test(i.warmupStatus ?? "") ? "paused" : "active");
/** A healthy value: quiet, so problems in the same column stand out. */
function Ok({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="ok-cell" title={title}>{children}</span>;
}

const campaignWord = (n: number) => `${n} campaign${n === 1 ? "" : "s"}`;

/** Whether the inboxes are in a running campaign: a domain in none sends nothing, so it has no numbers in Performance. */
function CampaignCell({ camp, total }: { camp: Group["camp"]; total: number }) {
  if (!total) return <span className="zero">—</span>;
  if (camp.live === total) return <Ok title={camp.liveNames.join("\n")}>{total === 1 && camp.liveNames.length === 1 ? camp.liveNames[0] : `In ${campaignWord(camp.liveNames.length)}`}</Ok>;
  if (camp.live) return <span className="ns-status tone-warning" title={`${total - camp.live} of ${total} inboxes aren't in a running campaign\n\nRunning: ${camp.liveNames.join(", ")}`}>{camp.live}/{total} inboxes</span>;
  if (camp.paused) return <span className="ns-status tone-warning" title={`Only in paused campaigns: ${camp.pausedNames.join(", ")}`}>Paused</span>;
  return <span className="ns-status tone-warning" title="Not in any running Smartlead campaign, so nothing is sent from it">Not in a campaign</span>;
}

function CampaignRollCell({ free, partial, domains }: { free: string[]; partial: number; domains: number }) {
  if (!domains) return <span className="zero">—</span>;
  if (!free.length && !partial) return <Ok title={`All ${domains} domains are in a running campaign`}>All in campaigns</Ok>;
  const said = [free.length ? `${free.length} of ${domains} not in one` : "", partial ? `${partial} partly` : ""].filter(Boolean).join(" · ");
  return <span className="ns-status tone-warning" title={free.length ? `Not in a running campaign:\n${free.join("\n")}` : undefined}>{said}</span>;
}

function DnsCell({ dns }: { dns: Dns }) {
  if (dns.state === "nozone") return <span className="ns-status tone-danger" title="The domain's nameservers have no zone for it: nothing resolves">No DNS zone</span>;
  if (dns.state === "unknown") return <span className="zero" title="Not checked yet">—</span>;
  return (
    dns.state === "ok"
      ? <Ok title="SPF, DKIM, DMARC and MX all published">Valid</Ok>
      : <span className="dns" title={`Missing: ${dns.missing.join(", ")}`}>{dns.missing.map((k) => <span key={k} className="dns-chip is-bad">{k}</span>)}</span>
  );
}
function WarmupCell({ blocked, paused, total, reason }: { blocked: number; paused: number; total: number; reason?: string | null }) {
  if (blocked) return <span className="ns-status tone-danger" title={reason ?? "Smartlead blocked warmup"}>{total > 1 ? `${blocked} blocked` : "Blocked"}</span>;
  if (paused) return <span className="ns-status tone-warning" title="Warmup is turned off in Smartlead">{paused === total ? "Off" : `${paused} off`}</span>;
  return <Ok>On</Ok>;
}
function BlacklistCell({ count, listings }: { count: number | null; listings: string[] }) {
  if (count == null) return <span className="zero" title="Not scanned yet. The scan needs a Smartlead token (SMARTLEAD_JWT) and runs every 6 hours.">—</span>;
  if (count === 0) return <Ok>Clean</Ok>;
  return <span className="ns-status tone-danger" title={listings.join(", ") || undefined}>Listed on {count}</span>;
}

/** Warming up: the day the domain is on, a bar, and when it is ready to move to a tag. */
/** Where a domain is on the Warming up tab. */
type Stage = "setup" | "dns" | "ready" | "warming" | "done";
const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: "setup", label: "Setting up", hint: "Replacement domains whose inboxes are still being set up at Hypertide or reaching Smartlead. Warm-up starts by itself once they're in and DNS is valid." },
  { key: "dns", label: "Waiting for DNS", hint: "New domains whose SPF, DKIM, DMARC or MX isn't found yet. Warm-up starts once all four are." },
  { key: "ready", label: "Ready to start", hint: "DNS is valid. Starts by itself when automatic warm-up is on, or with Start warm-up." },
  { key: "warming", label: "Warming", hint: "Warm-up running: counting the days set in Settings → Warming up." },
  { key: "done", label: "Done", hint: "Warm-up days are up. Move them to a tag to put them to work." },
];
/** Still being set up: its inboxes haven't all reached Smartlead yet. */
const inSetup = (g: Group) => g.setup != null && !isStepFinished(g.setup.stepSmartlead);
const stageOf = (g: Group): Stage => (g.warm ? (g.warm.ready ? "done" : "warming") : inSetup(g) ? "setup" : g.dns.state === "ok" ? "ready" : "dns");

/** One segment per warm-up day: done days filled, today lit, the rest empty. */
function WarmTrack({ g }: { g: Group }) {
  const stage = stageOf(g);
  if (!g.warm && stage === "setup" && g.setup) {
    const l = setupLabel(g.setup);
    return (
      <span className="wu-track is-idle">
        <span className={`wu-state is-setup${l.attention ? " is-attention" : ""}`} title={g.setup.lastError ?? `Replacing ${g.setup.oldDomain}. Open Replacements for every step.`}>{l.text}</span>
      </span>
    );
  }
  if (!g.warm) {
    return (
      <span className="wu-track is-idle">
        <span className={`wu-state is-${stage}`}>{stage === "ready" ? "Ready to start" : g.dns.state === "unknown" ? "Checking DNS…" : "Waiting for DNS"}</span>
      </span>
    );
  }
  const { day, days, ready, left } = g.warm;
  const done = ready ? days : day - 1;
  return (
    <span className="wu-track" title={ready ? `All ${days} days done` : `Day ${day} of ${days}: ${done} done, ${left} left after today`}>
      <span className="wu-segs" style={{ gridTemplateColumns: `repeat(${days}, 1fr)` }}>
        {Array.from({ length: days }, (_, k) => (
          <span key={k} className={k < done ? (ready ? "is-done" : "is-on") : k === done && !ready ? "is-today" : undefined} />
        ))}
      </span>
      <span className="wu-count">
        {ready ? <b className="is-done">Done</b> : <><b>{day}</b><span>/{days}</span></>}
        <em>{ready ? `${days} days` : `${left + 1} to go`}</em>
      </span>
    </span>
  );
}

function ChangeBadge({ change }: { change: InboxListRow["change"] }) {
  if (!change) return null;
  const what = Object.entries(change.changes).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ");
  if (change.status === "failed") return <span className="badge tone-danger" title={change.error ?? what}>Update failed</span>;
  if (change.status === "dry_run") return <span className="badge" title={`Dry run: would set ${what}`}>Dry run</span>;
  return null;
}

export function InboxesView({ inboxes, setups = [], clients, plans, smartleadConnected, dryRun, timezone, appProblem, newMaxAgeDays, inboxLimit }: {
  inboxes: InboxListRow[];
  /** Replacement domains still being set up, for Warming up. */
  setups?: SetupRow[]; clients: ClientRow[]; plans: PlanRow[]; smartleadConnected: boolean; dryRun: boolean; timezone: string;
  /** Settings → Warming up: how young a domain counts as new. */
  newMaxAgeDays: number;
  /** Domains with more inboxes than this are listed under Cleanup. */
  inboxLimit: number;
  /** Why the Smartlead token can't be used, or null when it can. */
  appProblem: string | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const params = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => tabOf(params.get("view")));
  // Links from Overview and the palette use ?view=…; follow the address when it changes.
  const urlView = params.get("view");
  const [lastUrlView, setLastUrlView] = useState(urlView);
  if (urlView !== lastUrlView) {
    setLastUrlView(urlView);
    setTab(tabOf(urlView));
  }
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  // Filters stay while you move between tabs and pages; Clear resets them.
  const [q, setQ] = useSticky("inboxes:q", "");
  const [clientId, setClientId] = useSticky("inboxes:client", "");
  const [sort, setSort] = useSticky<{ key: SortKey; dir: 1 | -1 }>("inboxes:sort", { key: "domain", dir: 1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  // One list of every domain, or grouped by client (and its tags). Remembered in this browser.
  const [grouping, setGrouping] = useState<Grouping>("none");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(GROUPING_KEY);
      // Restoring a saved preference after hydration is the point of this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "client" || v === "tags") setGrouping(v);
    } catch { /* storage unavailable: one list */ }
  }, []);
  const chooseGrouping = (g: Grouping) => {
    setGrouping(g);
    setOpen(new Set());
    setOpenClients(new Set());
    setOpenTags(new Set());
    try { window.localStorage.setItem(GROUPING_KEY, g); } catch { /* ignore */ }
  };
  const [esp, setEsp] = useSticky("inboxes:esp", "");
  const [acting, startAct] = useTransition();
  const act = (fn: () => Promise<{ ok: true; data: { message: string } } | { ok: false; error: string }>) =>
    startAct(async () => { const r = await fn(); if (r.ok) toast.success(r.data.message); else toast.error(r.error); });
  const cols = useColumns("inboxes", COLUMNS);
  const on = cols.on;
  const esps = useMemo(() => [...new Set(inboxes.map((i) => i.providerType).filter((x): x is string => Boolean(x)))].sort(), [inboxes]);
  // Where the inboxes come from (Hypertide, Icemail…), with how many domains each.
  const [provider, setProvider] = useSticky("inboxes:provider", "");
  const providers = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const i of inboxes) { const k = i.domainProvider ?? ""; m.set(k, (m.get(k) ?? new Set()).add(i.domainId)); }
    return [...m.entries()].map(([name, ids]) => ({ name, domains: ids.size })).sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name));
  }, [inboxes]);

  const base = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    return inboxes.filter((i) => (!client || i.clientName === client) && (!esp || i.providerType === esp)
      && (!provider || (provider === "-" ? !i.domainProvider : i.domainProvider === provider)));
  }, [inboxes, clients, clientId, esp, provider]);
  const [limitText, setLimitText] = useState(String(inboxLimit));
  const fresh = useMemo<Sets>(() => ({ fresh: freshDomains(inboxes, newMaxAgeDays), crowded: crowdedDomains(inboxes, inboxLimit), setup: new Map(setups.map((s) => [s.domainId, s])) }), [inboxes, newMaxAgeDays, inboxLimit, setups]);
  // Setting-up domains with no inbox in Smartlead yet, under the same client filter and search.
  const bareSetups = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    const withInboxes = new Set(inboxes.map((i) => i.domainId));
    return setups.filter((s) => !withInboxes.has(s.domainId) && (!client || s.clientName === client) && !esp && !provider);
  }, [setups, inboxes, clients, clientId, esp, provider]);
  const attentionCount = useMemo(() => group(base.filter((i) => i.domainInScope && tabMatch("attention", fresh)(i))).filter((g) => reasonsOf(g).length > 0).length, [base, fresh]);
  const lowRepInboxes = useMemo(() => base.filter((i) => i.status === "connected" && i.warmupReputation != null && i.warmupReputation < 90).length, [base]);
  // Domains in every view but Disconnected, which counts inboxes.
  const counts = useMemo(() => {
    const inView = (k: TabKey) => base.filter((i) => (k === "all" || i.domainInScope || (k === "warming" && onWarmingTab(i, fresh))) && tabMatch(k, fresh)(i));
    const domains = (k: TabKey) => new Set(inView(k).map((i) => i.domainId)).size;
    return { active: domains("active"), warming: domains("warming") + bareSetups.length, attention: attentionCount, cleanup: domains("cleanup"), disconnected: inView("disconnected").length, all: domains("all") } as Record<TabKey, number>;
  }, [base, attentionCount, fresh, bareSetups]);

  const groups = useMemo(() => {
    const match = tabMatch(tab, fresh);
    const needle = q.trim().toLowerCase();
    const shown = base.filter((i) => match(i) && (tab === "all" || i.domainInScope || (tab === "warming" && onWarmingTab(i, fresh))) && (!needle || i.email.includes(needle) || i.domain.includes(needle) || i.senderName?.toLowerCase().includes(needle) || i.smartleadTags.some((t) => t.toLowerCase().includes(needle))));
    const grouped = group(shown).map((g) => ({ ...g, setup: fresh.setup.get(g.domainId) ?? null }));
    if (tab === "warming") grouped.push(...bareSetups.filter((s) => !needle || s.domain.includes(needle) || s.oldDomain.includes(needle)).map(setupGroup));
    return grouped.filter((g) => tab !== "attention" || reasonsOf(g).length > 0).sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.domain.localeCompare(b.domain);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [base, tab, q, sort, fresh, bareSetups]);

  // The Warming up tab's domains by stage, before the stage filter.
  const warmStages = useMemo(() => {
    const by: Record<Stage, string[]> = { setup: [], dns: [], ready: [], warming: [], done: [] };
    if (tab === "warming") for (const g of groups) by[stageOf(g)].push(g.domainId);
    return by;
  }, [groups, tab]);

  // Keep the address in step so a view can be bookmarked or linked.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (tab === "active") p.delete("view"); else p.set("view", tab);
    const next = p.toString();
    window.history.replaceState(null, "", next ? `?${next}` : window.location.pathname);
  }, [tab]);

  const clientGroups = useMemo(() => byClient(groups).map((c) => (grouping === "tags" ? c : { ...c, tagGroups: null })).sort((a, b) => {
    // Clients follow the same sort as their domains; by name otherwise, "No client" last.
    const byName = (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.domain.localeCompare(b.domain);
    if (sort.key === "domain" || sort.key === "client") return byName * (sort.key === "client" ? sort.dir : 1);
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    if (x === y) return byName;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sort.dir;
  }), [groups, sort, grouping]);
  const all = useMemo(() => groups.flatMap((g) => g.inboxes), [groups]);
  const totals = useMemo(() => {
    const reps = all.map((i) => i.warmupReputation).filter((x): x is number => x != null);
    return {
      inboxes: all.length,
      capacity: all.reduce((a, i) => a + (i.dailyLimit ?? 0), 0),
      warmup: all.reduce((a, i) => a + (i.warmupEnabled ? i.warmupPerDay ?? 0 : 0), 0),
      avgRep: avg(reps),
    };
  }, [all]);

  const warmupOffCount = useMemo(() => all.filter((i) => !i.warmupEnabled).length, [all]);
  const disconnectedCount = useMemo(() => inboxes.filter((i) => i.status === "disconnected").length, [inboxes]);

  const selectedRows = useMemo(() => inboxes.filter((i) => selected.has(i.id)), [inboxes, selected]);
  const selectedDomains = useMemo(() => [...new Set(selectedRows.map((i) => i.domainId))], [selectedRows]);
  const selectedStatuses = useMemo(() => selectedDomains.map((id) => ({ id, status: selectedRows.find((x) => x.domainId === id)!.domainStatus })), [selectedDomains, selectedRows]);
  const replaceTargets = useMemo(() => selectedDomains.flatMap((id) => {
    const i = selectedRows.find((x) => x.domainId === id)!;
    return canReplace(i.domainStatus, i.domainBeingReplaced) ? [{ id, name: i.domain, tld: i.domainTld, clientName: i.clientName, clientHue: i.clientHue }] : [];
  }), [selectedDomains, selectedRows]);
  const current = useMemo(() => {
    const m = (f: (i: InboxListRow) => number | null) => avg(selectedRows.map(f).filter((x): x is number => x != null));
    // One value when every selected inbox has the same, else null.
    const same = <T,>(f: (i: InboxListRow) => T | null) => { const v = selectedRows.map(f); return v.length && v[0] != null && v.every((x) => x === v[0]) ? v[0] : null; };
    return {
      dailyLimit: m((i) => i.dailyLimit), minWait: m((i) => i.minWaitMins), warmupMin: m((i) => i.warmupMin), warmupPerDay: m((i) => i.warmupPerDay),
      // Smartlead doesn't report ramp-up; only what the app last wrote is known.
      warmupRampup: m((i) => (i.warmupRampupOn == null ? null : i.warmupRampup)), warmupRampupOn: same((i) => i.warmupRampupOn),
      warmupReplyRate: m((i) => i.warmupReplyRate),
      warmupTag: same((i) => i.warmupTag), tagsMixed: new Set(selectedRows.map((i) => i.warmupTag)).size > 1,
    };
  }, [selectedRows]);
  const selectedTags = useMemo(() => (selectedRows.length ? selectedRows[0].smartleadTags.filter((t) => selectedRows.every((i) => i.smartleadTags.includes(t))) : []), [selectedRows]);
  const knownTags = useMemo(() => [...new Set(inboxes.flatMap((i) => i.smartleadTags))].sort((a, b) => a.localeCompare(b)), [inboxes]);
  const toggleIds = (ids: string[]) => setSelected((s) => {
    const n = new Set(s);
    const on = ids.every((id) => n.has(id));
    for (const id of ids) if (on) n.delete(id); else n.add(id);
    return n;
  });
  // Shift-click a domain to select every domain between it and the last one clicked in the same list.
  const [anchor, setAnchor] = useState<{ list: string; domainId: string } | null>(null);
  const pickGroup = (list: string, order: Group[], g: Group, e?: { shiftKey?: boolean }) => {
    const from = anchor;
    setAnchor({ list, domainId: g.domainId });
    const a = e?.shiftKey && from?.list === list ? order.findIndex((x) => x.domainId === from.domainId) : -1;
    const b = order.findIndex((x) => x.domainId === g.domainId);
    if (a < 0 || b < 0) { toggleIds(g.inboxes.map((x) => x.id)); return; }
    const ids = g.inboxes.map((x) => x.id);
    const runIds = order.slice(Math.min(a, b), Math.max(a, b) + 1).flatMap((x) => x.inboxes.map((y) => y.id));
    setSelected((s) => {
      const n = new Set(s);
      const on = !ids.every((id) => s.has(id));
      for (const id of runIds) if (on) n.add(id); else n.delete(id);
      return n;
    });
  };
  const stageGroups = useMemo(() => groups.filter((g) => !stage || stageOf(g) === stage), [groups, stage]);
  const allIds = all.map((i) => i.id);
  const allSel = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSel = allIds.some((id) => selected.has(id));

  const colCount = 2 + COLUMNS.filter((col) => on(col.key)).length;
  // Every client, tag and domain row's key, the way the table builds them, for Expand all.
  const tagKeys = useMemo(() => clientGroups.flatMap((c) => c.tagGroups?.map((t) => t.key) ?? []), [clientGroups]);
  const domainKeys = useMemo(() => (grouping === "none" ? groups.map((d) => `all|${d.domainId}`) : clientGroups.flatMap((c) => c.tagGroups
    ? c.tagGroups.flatMap((t) => t.domains.map((d) => `${t.key}|${d.domainId}`))
    : c.domains.map((d) => `${c.key}|${d.domainId}`))), [clientGroups, groups, grouping]);
  const anyOpen = openClients.size > 0 || open.size > 0;
  const expandTo = (level: "tags" | "domains" | "inboxes" | null) => {
    setOpenClients(level ? new Set(clientGroups.map((c) => c.key)) : new Set());
    setOpenTags(level === "domains" || level === "inboxes" ? new Set(tagKeys) : new Set());
    setOpen(level === "inboxes" ? new Set(domainKeys) : new Set());
  };
  const flip = (id: string) => (s: Set<string>) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const toggle = (id: string) => setOpen(flip(id));
  const toggleClient = (key: string) => setOpenClients(flip(key));
  const toggleTag = (key: string) => setOpenTags(flip(key));
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "domain" || key === "client" ? 1 : -1 }));

  // The cells a client or tag row shares: totals for the group, each marked Sum or Avg.
  const summaryCells = (c: ClientGroup) => (
    <>
      {on("status") ? (
        <td>
          {!c.activeDomains ? null : c.liveDomains === c.activeDomains
            ? <Ok title="Every active domain has an active order and all its inboxes connected">{c.liveDomains} active</Ok>
            : <span className="ns-status tone-warning" title="Active domains whose order isn't active or with inboxes disconnected in Smartlead">{c.liveDomains} of {c.activeDomains} active</span>}
        </td>
      ) : null}
      {on("client") ? <td /> : null}
      {on("esp") ? <td>{c.esp ? <EspBadge type={c.esp} /> : <span className="zero">—</span>}</td> : null}
      {on("tags") ? <td /> : null}
      {on("count") ? <td className="is-num st-vol st-start strong"><span className="st-agg">Sum</span>{int(c.count)}</td> : null}
      {on("warmup") ? <td className="is-num st-vol"><span className="st-agg">Avg</span>{n0(c.avgWarmup)}{c.warmupOff ? <span className="text-faint"> · {c.warmupOff} off</span> : null}</td> : null}
      {on("limit") ? <td className="is-num st-vol"><span className="st-agg">Avg</span>{n0(c.avgLimit)}</td> : null}
      {on("capacity") ? <td className="is-num st-vol strong"><span className="st-agg">Sum</span>{c.capacity ? int(c.capacity) : <span className="zero">0</span>}</td> : null}
      {on("today") ? <td className="is-num st-vol"><span className="st-agg">Sum</span>{c.sentToday ? int(c.sentToday) : <span className="zero">0</span>}</td> : null}
      {on("gap") ? <td className="is-num st-vol">{c.avgWait != null ? `${Math.round(c.avgWait)}m` : <span className="zero">—</span>}</td> : null}
      {on("rep") ? <td className="is-num st-health st-start"><span className="st-agg">Avg</span><Rep value={c.avgRep} low={c.lowRep} /></td> : null}
      {on("age") ? <td /> : null}
      {on("dns") ? <td>{c.dnsBad ? <span className="ns-status tone-danger" title={`Missing: ${c.dns.missing.join(", ")}`}>{c.dnsBad} with gaps</span> : c.dns.state === "unknown" ? <span className="zero">—</span> : <Ok>Valid</Ok>}</td> : null}
      {on("warmupState") ? <td><WarmupCell blocked={c.blocked} paused={c.paused} total={c.count} /></td> : null}
      {on("blacklist") ? <td>{c.bl == null ? <span className="zero">—</span> : c.listed ? <span className="ns-status tone-danger" title={c.blListings.join(", ")}>{c.listed} listed</span> : <Ok>Clean</Ok>}</td> : null}
      {on("campaigns") ? <td><CampaignRollCell free={c.campFree} partial={c.campPartial} domains={c.domains.filter((d) => d.count > 0).length} /></td> : null}
      {on("connection") ? <td>{c.disconnected ? <span className="ns-status tone-danger">{c.disconnected} disconnected</span> : <Ok title={`All ${c.count} inboxes connected`}>{c.count}/{c.count}</Ok>}</td> : null}
    </>
  );

  // A list of domains, each opening onto its inboxes. `prefix` keeps a domain that sits under two tags apart.
  const domainRows = (domains: Group[], prefix: string, pad: number) => domains.map((g, gi) => {
    const dKey = prefix + g.domainId;
    const isOpen = open.has(dKey);
    const ids = g.inboxes.map((i) => i.id);
    const gSel = ids.every((id) => selected.has(id));
    const gSome = ids.some((id) => selected.has(id));
    return (
      <Fragment key={dKey}>
        <tr className="is-clickable" aria-expanded={isOpen} data-selected={gSel} onClick={() => toggle(dKey)}>
          <td className="col-check" onMouseDown={keepTextUnselected} onClick={(e) => { e.stopPropagation(); pickGroup(prefix, domains, g, e); }}>
            <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
          </td>
          <td className="col-first" style={{ paddingLeft: pad }}>
            <span className="flex items-center gap-1.5">
              <span className="st-n">{gi + 1}</span>
              <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
              <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
              <TagList tags={g.domainTags} graceDaysLeft={g.graceDaysLeft} />
            </span>
          </td>
          {on("status") ? <td><DomainState g={g} /></td> : null}
          {on("client") ? <td><ClientCell name={g.clientName} hue={g.clientHue} /></td> : null}
          {on("esp") ? <td>{g.esp ? <EspBadge type={g.esp} /> : <span className="zero">—</span>}</td> : null}
          {on("tags") ? <td><Tags tags={g.tags} graceDaysLeft={g.graceDaysLeft} /></td> : null}
          {on("count") ? <td className="is-num st-vol st-start">{int(g.count)}</td> : null}
          {on("warmup") ? (
            <td className="is-num st-vol" title={g.warmupOff ? `${g.warmupOff} with warmup off` : undefined}>
              {n0(g.avgWarmup)}{g.warmupOff ? <span className="text-faint"> · {g.warmupOff} off</span> : null}
            </td>
          ) : null}
          {on("limit") ? <td className="is-num st-vol">{n0(g.avgLimit)}</td> : null}
          {on("capacity") ? <td className="is-num st-vol">{g.capacity ? int(g.capacity) : <span className="zero">0</span>}</td> : null}
          {on("today") ? <td className="is-num st-vol">{g.sentToday ? int(g.sentToday) : <span className="zero">0</span>}</td> : null}
          {on("gap") ? <td className="is-num st-vol">{g.avgWait != null ? `${Math.round(g.avgWait)}m` : <span className="zero">—</span>}</td> : null}
          {on("rep") ? (
            <td className="is-num st-health st-start" title={g.minRep != null ? `Lowest ${g.minRep.toFixed(0)}${g.lowRep ? `, ${g.lowRep} under 90` : ""}` : undefined}>
              <Rep value={g.avgRep} low={g.lowRep} />
            </td>
          ) : null}
          {on("age") ? <td className="is-num" title={g.ageDays != null ? `${g.ageDays} days since the first inbox was added to Smartlead` : "Not known yet"}>{ageLabel(g.ageDays) ?? <span className="zero">—</span>}</td> : null}
          {on("dns") ? <td><DnsCell dns={g.dns} /></td> : null}
          {on("warmupState") ? <td><WarmupCell blocked={g.blocked} paused={g.paused} total={g.count} /></td> : null}
          {on("blacklist") ? <td><BlacklistCell count={g.bl} listings={g.blListings} /></td> : null}
          {on("campaigns") ? <td><CampaignCell camp={g.camp} total={g.count} /></td> : null}
          {on("connection") ? <td>{g.disconnected ? <span className="ns-status tone-danger">{g.disconnected} disconnected</span> : <Ok title={`All ${g.count} inboxes connected`}>{g.count}/{g.count}</Ok>}</td> : null}
        </tr>
        {isOpen ? [...g.inboxes].sort(byValue((i: InboxListRow) => inboxValue(i, sort.key), (a, b) => a.email.localeCompare(b.email), sort.dir)).map((i) => (
          <tr key={i.id} className="is-clickable" data-selected={selected.has(i.id)} style={{ background: "var(--surface-2)" }} onClick={() => toggleIds([i.id])}>
            <td className="col-check"><input type="checkbox" className="checkbox" checked={selected.has(i.id)} onChange={() => {}} aria-label={`Select ${i.email}`} tabIndex={-1} /></td>
            <td className="col-first" style={{ paddingLeft: pad + 54 }}>
              <span className="flex items-center gap-2" title={i.lastSyncedAt ? `Synced ${ago(i.lastSyncedAt)}` : undefined}>
                <span className="text-ink-soft">{i.email}</span>
                {i.status !== "connected" ? <span className="badge">{i.status}</span> : null}
                <ChangeBadge change={i.change} />
              </span>
            </td>
            {on("status") ? <td /> : null}
            {on("client") ? <td className="text-muted">{i.senderName ?? <span className="zero">—</span>}</td> : null}
            {on("esp") ? <td>{i.providerType ? <EspBadge type={i.providerType} /> : <span className="zero">—</span>}</td> : null}
            {on("tags") ? <td><Tags tags={i.smartleadTags} graceDaysLeft={i.domainGraceDaysLeft} /></td> : null}
            {on("count") ? <td className="is-num st-vol st-start"><span className="zero">—</span></td> : null}
            {on("warmup") ? (
              <td className="is-num st-vol" title={i.warmupMin != null ? `Smartlead sends ${i.warmupMin}–${i.warmupPerDay} a day${i.warmupReplyRate != null ? `, ${i.warmupReplyRate}% reply rate` : ""}` : undefined}>
                {i.warmupEnabled ? (i.warmupMin != null && i.warmupMin !== i.warmupPerDay ? `${i.warmupMin}–${i.warmupPerDay}` : int(i.warmupPerDay)) : <span className="zero">off</span>}
                {i.warmupRampup ? <span className="text-faint"> · +{i.warmupRampup}</span> : null}
              </td>
            ) : null}
            {on("limit") ? <td className="is-num st-vol">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td> : null}
            {on("capacity") ? <td className="is-num st-vol">{i.dailyLimit ? int(i.dailyLimit) : <span className="zero">0</span>}</td> : null}
            {on("today") ? <td className="is-num st-vol">{i.dailySent ? int(i.dailySent) : <span className="zero">0</span>}</td> : null}
            {on("gap") ? <td className="is-num st-vol">{i.minWaitMins != null ? `${i.minWaitMins}m` : <span className="zero">—</span>}</td> : null}
            {on("rep") ? <td className="is-num st-health st-start"><Rep value={i.warmupReputation} low={0} /></td> : null}
            {on("age") ? <td className="is-num text-muted" title="Inbox added to Smartlead">{i.smartleadCreatedAt ? ageLabel(Math.floor((Date.now() - new Date(i.smartleadCreatedAt).getTime()) / 86_400_000)) : <span className="zero">—</span>}</td> : null}
            {on("dns") ? <td /> : null}
            {on("warmupState") ? <td><WarmupCell blocked={warmupOf(i) === "blocked" ? 1 : 0} paused={warmupOf(i) === "paused" ? 1 : 0} total={1} reason={i.warmupBlockedReason} /></td> : null}
            {on("blacklist") ? <td /> : null}
            {on("campaigns") ? <td><CampaignCell camp={{ live: i.liveCampaigns.length ? 1 : 0, paused: !i.liveCampaigns.length && i.pausedCampaigns.length ? 1 : 0, liveNames: i.liveCampaigns, pausedNames: i.pausedCampaigns }} total={1} /></td> : null}
            {on("connection") ? <td>{i.status === "disconnected" ? <span className="ns-status tone-danger" title={i.connectError ?? undefined}>{i.connectError ? i.connectError.slice(0, 32) : "Disconnected"}</span> : <Ok>Connected</Ok>}</td> : null}
          </tr>
        )) : null}
      </Fragment>
    );
  });

  return (
    <div className="inb-page flex flex-col gap-2">
      {!smartleadConnected ? (
        <div className="callout tone-info">
          <Info size={15} strokeWidth={1.75} />
          <span>
            Showing the last synced settings. Add your Smartlead API key in <Link href="/settings" className="underline">Settings</Link> to
            change warmup and daily limits from here.
          </span>
        </div>
      ) : null}

      {/* Row 1: which view, and the numbers for what it shows. */}
      <div className="inb-row">
        <div className="view-tabs inb-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
              {t.label} <span>{int(counts[t.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        <span className="spacer-auto" />
        <dl className="inb-kpis" aria-label="Inbox numbers">
          <div className="inb-kpi" title={`${int(totals.inboxes)} inboxes on ${int(groups.length)} domains, ${groups.length ? (totals.inboxes / groups.length).toFixed(1) : "0"} per domain`}>
            <dt>Inboxes</dt><dd>{int(totals.inboxes)}</dd><span>{int(groups.length)} domains</span>
          </div>
          <div className="inb-kpi" title={`Campaign emails a day: ${totals.inboxes ? (totals.capacity / totals.inboxes).toFixed(1) : "0"} per inbox on average`}>
            <dt>Campaign / day</dt><dd>{int(totals.capacity)}</dd><span>{totals.inboxes ? (totals.capacity / totals.inboxes).toFixed(1) : "0"} per inbox</span>
          </div>
          <div className="inb-kpi" title={`Warmup emails a day. ${int(warmupOffCount)} inboxes with warmup off`}>
            <dt>Warmup / day</dt><dd>{int(totals.warmup)}</dd><span>{int(warmupOffCount)} off</span>
          </div>
          <div className="inb-kpi" title={`Average warmup reputation. ${int(lowRepInboxes)} connected inboxes under 90`}>
            <dt>Reputation</dt><dd>{totals.avgRep == null ? "—" : totals.avgRep.toFixed(1)}</dd><span className={lowRepInboxes ? "is-warn" : undefined}>{int(lowRepInboxes)} under 90</span>
          </div>
        </dl>
      </div>

      {/* Row 2: find and filter on the left, the stage strip on Warming up, actions on the right. */}
      <div className="inb-row">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search inboxes" />
        </label>
        <Select className="select" style={{ width: 128 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="select" style={{ width: 112 }} value={esp} onChange={(e) => setEsp(e.target.value)} aria-label="Filter by ESP">
          <option value="">All ESPs</option>
          {esps.map((x) => <option key={x} value={x}>{espLabel(x)}</option>)}
        </Select>
        {providers.length > 1 ? (
          <Select className="select" style={{ width: 128 }} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Filter by inbox provider">
            <option value="">All providers</option>
            {providers.map((p) => <option key={p.name || "-"} value={p.name || "-"}>{p.name || "No provider"} · {int(p.domains)}</option>)}
          </Select>
        ) : null}
        {clientId || esp || provider || q ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setClientId(""); setEsp(""); setProvider(""); setQ(""); }}>Clear</button> : null}
        {tab === "warming" ? (
          <div className="wu-strip" role="group" aria-label="Warm-up stages">
            {STAGES.map((s) => {
              const n = warmStages[s.key].length;
              return (
                <button key={s.key} type="button" className={`wu-chip is-${s.key}`} aria-pressed={stage === s.key} data-empty={n === 0} title={s.hint}
                  onClick={() => setStage((x) => (x === s.key ? null : s.key))}>
                  <i />{s.label}<b>{int(n)}</b>
                </button>
              );
            })}
          </div>
        ) : null}
        <span className="spacer-auto" />
        {FLAT.includes(tab) ? null : (
          <Select className="select" style={{ width: 170 }} value={grouping} onChange={(e) => chooseGrouping(e.target.value as Grouping)} aria-label="Group domains">
            <option value="none">No grouping</option>
            <option value="client">Group by client</option>
            <option value="tags">Group by client and tag</option>
          </Select>
        )}
        {FLAT.includes(tab) ? null : grouping === "none" ? (
          <button type="button" className="btn btn-sm" title={anyOpen ? "Close every domain" : "Show every domain's inboxes"} onClick={() => expandTo(anyOpen ? null : "inboxes")}>
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="btn btn-sm menu-trigger" title="Open or close every client, tag and domain">
                {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {anyOpen ? "Expanded" : "Expand"} <ChevronDown size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 220 }}>
                <DropdownMenu.Label className="menu-label">Expand all to</DropdownMenu.Label>
                {tagKeys.length ? <DropdownMenu.Item className="menu-item" onSelect={() => expandTo("tags")}>Tags</DropdownMenu.Item> : null}
                <DropdownMenu.Item className="menu-item" onSelect={() => expandTo("domains")}>Domains <span className="menu-hint">{int(groups.length)}</span></DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => expandTo("inboxes")}>Every inbox <span className="menu-hint">{int(totals.inboxes)}</span></DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item" disabled={!anyOpen} onSelect={() => expandTo(null)}>Collapse all</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <button type="button" className="btn btn-sm" disabled={acting} title="Check SPF, DKIM, DMARC and MX now (selected domains, or all sending domains)" onClick={() => act(() => validateDns(selectedDomains))}>
          <ShieldCheck size={14} /> Validate DNS{selectedDomains.length ? ` (${selectedDomains.length})` : ""}
        </button>
        <button type="button" className="btn btn-sm" disabled={acting || Boolean(appProblem)} title={appProblem ?? "Ask Smartlead to retry the login of every disconnected inbox"} onClick={() => act(reconnectInboxes)}>
          <PlugZap size={14} /> Reconnect{disconnectedCount ? ` (${int(disconnectedCount)})` : ""}
        </button>
        {tab === "warming" && warmStages.ready.length ? (() => {
          const ready = new Set(warmStages.ready);
          const chosen = selectedDomains.filter((id) => ready.has(id));
          return (
            <button type="button" className="btn btn-sm btn-primary" disabled={acting || !smartleadConnected}
              title="Switch warmup on with the values from Settings → Warming up and tag the inboxes New. Only domains with valid DNS."
              onClick={() => act(() => startWarmupNow(chosen.length ? chosen : warmStages.ready))}>
              <Flame size={14} /> Start warm-up ({chosen.length || ready.size})
            </button>
          );
        })() : null}
        {FLAT.includes(tab) ? null : <ColumnsMenu cols={cols} />}
      </div>

      {tab === "cleanup" ? (
        <div className="cln-bar">
          <span className="cln-bar-text">
            Domains with more than
            <input className="input num cl-limit" inputMode="numeric" value={limitText} aria-label="Inbox limit per domain"
              onChange={(e) => setLimitText(e.target.value)}
              onBlur={() => { const n = Number(limitText); if (n && n !== inboxLimit) act(async () => { const r = await saveInboxLimit(n); return r.ok ? { ok: true as const, data: { message: `Limit set to ${n} inboxes a domain` } } : r; }); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            inboxes, or inboxes under more than one sender name. Click a sender to select its inboxes, then copy their addresses.
          </span>
        </div>
      ) : null}

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 210px)", minHeight: 260 }}>
          {tab === "warming" ? (
            <table className="data-table is-main wu-table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown domains" checked={allSel}
                      ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                      onChange={() => setSelected((s0) => { const n = new Set(s0); for (const id of allIds) if (allSel) n.delete(id); else n.add(id); return n; })} />
                  </th>
                  <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                  <SortTh k="progress" sort={sort} onSort={sortBy} className="wu-col-track">Warm-up progress</SortTh>
                  <SortTh k="age" sort={sort} onSort={sortBy} num title="Days since the first inbox was added to Smartlead">Age</SortTh>
                  <SortTh k="dnsMissing" sort={sort} onSort={sortBy}>DNS</SortTh>
                  <SortTh k="warmupState" sort={sort} onSort={sortBy}>Warmup</SortTh>
                  <SortTh k="avgWarmup" sort={sort} onSort={sortBy} num title="Warmup emails a day, per inbox">Warmup / day</SortTh>
                  <SortTh k="avgLimit" sort={sort} onSort={sortBy} num title="Campaign limit a day, per inbox">Limit</SortTh>
                  <SortTh k="count" sort={sort} onSort={sortBy} num>Inboxes</SortTh>
                  <SortTh k="avgRep" sort={sort} onSort={sortBy} num>Reputation</SortTh>
                  <SortTh k="tags" sort={sort} onSort={sortBy}>Tag</SortTh>
                </tr>
              </thead>
              <tbody>
                {stageGroups.map((g) => {
                  const ids = g.inboxes.map((x) => x.id);
                  const gSel = ids.length > 0 && ids.every((id) => selected.has(id));
                  const gSome = ids.some((id) => selected.has(id));
                  return (
                    <tr key={g.domainId} className="is-clickable" data-selected={gSel} onMouseDown={keepTextUnselected} onClick={(e) => pickGroup("warm", stageGroups, g, e)}>
                      <td className="col-check">
                        <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} disabled={!ids.length} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="wu-name">
                          <span className="flex items-center gap-1.5">
                            <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
                            <TagList tags={g.domainTags} graceDaysLeft={g.graceDaysLeft} />
                          </span>
                          <span className="wu-sub">{g.clientName ?? "No client"}{g.esp ? ` · ${espLabel(g.esp)}` : ""}{g.setup ? ` · replacing ${g.setup.oldDomain}` : ""}</span>
                        </span>
                      </td>
                      <td className="wu-col-track"><WarmTrack g={g} /></td>
                      <td className="is-num" title={g.ageDays != null ? `${g.ageDays} days since the first inbox was added to Smartlead` : "Not known yet"}>{g.ageDays == null ? <span className="zero">—</span> : `${g.ageDays}d`}</td>
                      <td><DnsCell dns={g.dns} /></td>
                      <td>{g.count ? <WarmupCell blocked={g.blocked} paused={g.paused} total={g.count} /> : <span className="zero" title="No inbox in Smartlead yet">—</span>}</td>
                      <td className="is-num">{g.avgWarmup == null ? <span className="zero">—</span> : Math.round(g.avgWarmup)}</td>
                      <td className="is-num">{g.avgLimit == null ? <span className="zero">—</span> : Math.round(g.avgLimit)}</td>
                      <td className="is-num">{int(g.count)}</td>
                      <td className="is-num" title={g.minRep != null ? `Lowest ${g.minRep.toFixed(0)}` : undefined}><Rep value={g.avgRep} low={g.lowRep} /></td>
                      <td><Tags tags={g.tags.filter((t) => !isMark(t))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : tab === "cleanup" ? (
            <table className="data-table is-main cl-table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown domains" checked={allSel}
                      ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                      onChange={() => setSelected((s0) => { const n = new Set(s0); for (const id of allIds) if (allSel) n.delete(id); else n.add(id); return n; })} />
                  </th>
                  <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                  <SortTh k="count" sort={sort} onSort={sortBy} num title={`Inboxes on the domain; more than ${inboxLimit} is listed here`}>Inboxes</SortTh>
                  <SortTh k="senders" sort={sort} onSort={sortBy} title="Click a sender to select its inboxes on that domain">Sender names</SortTh>
                  <SortTh k="age" sort={sort} onSort={sortBy} num>Age</SortTh>
                  <SortTh k="tags" sort={sort} onSort={sortBy}>Tag</SortTh>
                  <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const ids = g.inboxes.map((x) => x.id);
                  const gSel = ids.every((id) => selected.has(id));
                  const gSome = ids.some((id) => selected.has(id));
                  const over = g.count - inboxLimit;
                  return (
                    <tr key={g.domainId} data-selected={gSel}>
                      <td className="col-check" onClick={() => toggleIds(ids)}>
                        <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="wu-name">
                          <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
                          <span className="wu-sub">{g.clientName ?? "No client"}{g.esp ? ` · ${espLabel(g.esp)}` : ""}{g.setup ? ` · replacing ${g.setup.oldDomain}` : ""}</span>
                        </span>
                      </td>
                      <td className="is-num">
                        <span className="cl-count">
                          <span className={over > 0 ? "strong" : undefined}>{int(g.count)}</span>
                          {over > 0 ? <span className="ns-status tone-danger">+{over}</span> : null}
                        </span>
                      </td>
                      <td>
                        <span className="cl-senders">
                          {g.senders.map((s) => {
                            const sOn = s.ids.every((id) => selected.has(id));
                            return (
                              <button key={s.name} type="button" className="cl-sender" aria-pressed={sOn}
                                title={`Select the ${s.ids.length} inbox${s.ids.length === 1 ? "" : "es"} sending as ${s.name}${s.added != null ? `, first added ${s.added} days ago` : ""}`}
                                onClick={() => toggleIds(s.ids)}>
                                <span className="cl-sender-name">{s.name}</span>
                                <span className="cl-sender-n">{int(s.ids.length)}</span>
                                {s.added != null ? <span className="cl-sender-age">{s.added}d</span> : null}
                              </button>
                            );
                          })}
                        </span>
                      </td>
                      <td className="is-num" title={g.ageDays != null ? `${g.ageDays} days since the first inbox was added to Smartlead` : "Not known yet"}>{ageLabel(g.ageDays) ?? <span className="zero">—</span>}</td>
                      <td><Tags tags={g.tags.filter((t) => !isMark(t))} /></td>
                      <td><DomainState g={g} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : FLAT.includes(tab) ? (
            <table className="data-table is-main">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" className="checkbox" aria-label="Select all shown domains" checked={allSel}
                      ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                      onChange={() => setSelected((s0) => { const n = new Set(s0); for (const id of allIds) if (allSel) n.delete(id); else n.add(id); return n; })} />
                  </th>
                  <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                  <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                  <SortTh k="tags" sort={sort} onSort={sortBy}>Tag</SortTh>
                  <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh>
                  {tab === "attention" ? <SortTh k="reasons" sort={sort} onSort={sortBy}>What needs attention</SortTh> : null}
                  <SortTh k="count" sort={sort} onSort={sortBy} num>Inboxes</SortTh>
                  <SortTh k="age" sort={sort} onSort={sortBy} num>Age</SortTh>
                  <SortTh k="warmupState" sort={sort} onSort={sortBy}>Warmup</SortTh>
                  <SortTh k="avgRep" sort={sort} onSort={sortBy} num>Reputation</SortTh>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => {
                  const ids = g.inboxes.map((x) => x.id);
                  const gSel = ids.every((id) => selected.has(id));
                  const gSome = ids.some((id) => selected.has(id));
                  return (
                    <tr key={g.domainId} className="is-clickable" data-selected={gSel} onMouseDown={keepTextUnselected} onClick={(e) => pickGroup("flat", groups, g, e)}>
                      <td className="col-check">
                        <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="flex items-center gap-2">
                          <span className="st-n">{i + 1}</span>
                          <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
                          <TagList tags={g.domainTags} graceDaysLeft={g.graceDaysLeft} />
                        </span>
                      </td>
                      <td><ClientCell name={g.clientName} hue={g.clientHue} /></td>
                      <td><Tags tags={g.tags.filter((t) => !isMark(t))} /></td>
                      <td><DomainState g={g} /></td>
                      {tab === "attention" ? (
                        <td>
                          <span className="flex flex-wrap gap-1">
                            {reasonsOf(g).map((r) => <span key={r.label} className={`ns-status tone-${r.tone}`}>{r.label}</span>)}
                          </span>
                        </td>
                      ) : null}
                      <td className="is-num">{int(g.count)}</td>
                      <td className="is-num" title={g.ageDays != null ? `${g.ageDays} days since the first inbox was added to Smartlead` : "Not known yet"}>{ageLabel(g.ageDays) ?? <span className="zero">—</span>}</td>
                      <td><WarmupCell blocked={g.blocked} paused={g.paused} total={g.count} /></td>
                      <td className="is-num" title={g.minRep != null ? `Lowest ${g.minRep.toFixed(0)}` : undefined}><Rep value={g.avgRep} low={g.lowRep} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
          <table className="data-table is-main">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" className="checkbox" aria-label="Select all shown inboxes" checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                    onChange={() => setSelected((s0) => { const n = new Set(s0); for (const id of allIds) if (allSel) n.delete(id); else n.add(id); return n; })} />
                </th>
                <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                {on("status") ? <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh> : null}
                {on("client") ? <SortTh k="client" sort={sort} onSort={sortBy}>Client / sender</SortTh> : null}
                {on("esp") ? <SortTh k="esp" sort={sort} onSort={sortBy}>ESP</SortTh> : null}
                {on("tags") ? <SortTh k="tags" sort={sort} onSort={sortBy}>Smartlead tags</SortTh> : null}
                {on("count") ? <SortTh k="count" sort={sort} onSort={sortBy} num className="st-vol st-start">Inboxes</SortTh> : null}
                {on("warmup") ? <SortTh k="avgWarmup" sort={sort} onSort={sortBy} num className="st-vol" title="Warmup emails a day, per inbox">Warmup</SortTh> : null}
                {on("limit") ? <SortTh k="avgLimit" sort={sort} onSort={sortBy} num className="st-vol" title="Daily campaign limit, per inbox">Limit</SortTh> : null}
                {on("capacity") ? <SortTh k="capacity" sort={sort} onSort={sortBy} num className="st-vol" title="Campaign emails a day, all inboxes together">Per day</SortTh> : null}
                {on("today") ? <SortTh k="sentToday" sort={sort} onSort={sortBy} num className="st-vol" title="Campaign emails sent today, as Smartlead counts them">Today</SortTh> : null}
                {on("gap") ? <SortTh k="avgWait" sort={sort} onSort={sortBy} num className="st-vol" title="Minimum minutes between campaign emails">Gap</SortTh> : null}
                {on("rep") ? <SortTh k="avgRep" sort={sort} onSort={sortBy} num className="st-health st-start">Reputation</SortTh> : null}
                {on("age") ? <SortTh k="age" sort={sort} onSort={sortBy} num>Age</SortTh> : null}
                {on("dns") ? <SortTh k="dnsMissing" sort={sort} onSort={sortBy}>DNS</SortTh> : null}
                {on("warmupState") ? <SortTh k="warmupState" sort={sort} onSort={sortBy}>Warmup status</SortTh> : null}
                {on("blacklist") ? <SortTh k="blacklist" sort={sort} onSort={sortBy}>Blacklist</SortTh> : null}
                {on("campaigns") ? <SortTh k="campaigns" sort={sort} onSort={sortBy} title="Whether the inboxes are in a running Smartlead campaign. A domain in none sends nothing, so it shows no numbers in Performance">Campaigns</SortTh> : null}
                {on("connection") ? <SortTh k="connection" sort={sort} onSort={sortBy}>Connection</SortTh> : null}
              </tr>
            </thead>
            <tbody>
              {grouping === "none" ? domainRows(groups, "all|", 12) : clientGroups.map((c) => {
                const cOpen = openClients.has(c.key);
                const cIds = c.inboxes.map((i) => i.id);
                const cSel = cIds.every((id) => selected.has(id));
                const cSome = cIds.some((id) => selected.has(id));
                return (
                  <Fragment key={c.key || "none"}>
                    <tr className="is-clickable inb-client" aria-expanded={cOpen} data-selected={cSel} onClick={() => toggleClient(c.key)}>
                      <td className="col-check" onClick={(e) => { e.stopPropagation(); toggleIds(cIds); }}>
                        <input type="checkbox" className="checkbox" checked={cSel} ref={(el) => { if (el) el.indeterminate = !cSel && cSome; }} onChange={() => {}} aria-label={`Select every inbox of ${c.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="flex items-center gap-2">
                          <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: cOpen ? "rotate(90deg)" : undefined }} />
                          <span className="st-client-name">
                            <span className="st-cap">Client</span>
                            <ClientCell name={c.domain} hue={c.clientHue} />
                          </span>
                          <span className="st-count" title={c.tagGroups ? `${c.tagGroups.length} tags, ${c.domains.length} domains` : `${c.domains.length} domain${c.domains.length === 1 ? "" : "s"}`}>{c.tagGroups ? c.tagGroups.length : c.domains.length}</span>
                        </span>
                      </td>
                      {summaryCells(c)}
                    </tr>
                    {cOpen ? (c.tagGroups
                      ? c.tagGroups.map((t) => {
                          const tOpen = openTags.has(t.key);
                          const tIds = t.inboxes.map((i) => i.id);
                          const tSel = tIds.every((id) => selected.has(id));
                          const tSome = tIds.some((id) => selected.has(id));
                          return (
                            <Fragment key={t.key}>
                              <tr className="is-clickable inb-tag" aria-expanded={tOpen} data-selected={tSel} onClick={() => toggleTag(t.key)}>
                                <td className="col-check" onClick={(e) => { e.stopPropagation(); toggleIds(tIds); }}>
                                  <input type="checkbox" className="checkbox" checked={tSel} ref={(el) => { if (el) el.indeterminate = !tSel && tSome; }} onChange={() => {}} aria-label={`Select every inbox tagged ${t.domain}`} tabIndex={-1} />
                                </td>
                                <td className="col-first" style={{ paddingLeft: 22 }}>
                                  <span className="flex items-center gap-2">
                                    <ChevronRight size={14} className="flex-none text-faint transition-transform" style={{ transform: tOpen ? "rotate(90deg)" : undefined }} />
                                    <span className="st-client-name">
                                      <span className="st-cap">Tag</span>
                                      <span className="strong">{t.domain}</span>
                                    </span>
                                    <span className="st-count" title={`${t.domains.length} domain${t.domains.length === 1 ? "" : "s"}`}>{t.domains.length}</span>
                                  </span>
                                </td>
                                {summaryCells(t)}
                              </tr>
                              {tOpen ? domainRows(t.domains, `${t.key}|`, 40) : null}
                            </Fragment>
                          );
                        })
                      : domainRows(c.domains, `${c.key}|`, 12)) : null}
                    {cOpen ? <tr className="st-gap" aria-hidden><td colSpan={colCount} /></tr> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          )}
          {groups.length === 0 ? <Empty icon={Inbox} title={tab === "attention" ? "Nothing needs attention" : tab === "warming" ? "No domains are warming up" : tab === "cleanup" ? "Nothing to clean up" : "No inboxes here"}>{tab === "attention" ? "Every active domain is connected, warmed and clean." : tab === "cleanup" ? `Every domain has at most ${inboxLimit} inboxes, all under one sender name.` : tab === "warming" ? "New domains that connect to Smartlead appear here and warm up for the days set in Settings → Warming up." : "Inboxes appear once a domain is set up on Hypertide and connected to Smartlead."}</Empty> : null}
        </div>
        <div className="table-footer">
          <span><b>{int(groups.length)}</b> domains</span>
          <span><b>{int(totals.inboxes)}</b> inboxes</span>
          <span><b>{int(totals.capacity)}</b> campaign emails a day</span>
          <span><b>{int(totals.warmup)}</b> warmup a day</span>
          <span className="table-footer-hint hidden md:inline-flex">Tick domains or inboxes to edit them</span>
        </div>
      </div>

      <PlansCard plans={plans} clients={clients} selectedDomainIds={selectedDomains} timezone={timezone} />

      {selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Selected inboxes">
          <span className="bulk-count">{selected.size} inbox{selected.size === 1 ? "" : "es"} · {selectedDomains.length} domain{selectedDomains.length === 1 ? "" : "s"}</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={!smartleadConnected} onClick={() => setEditOpen(true)}><Settings2 size={14} /> Configure settings</button>
          <button type="button" className="btn btn-sm" disabled={!smartleadConnected} title="Move the selected domains to a Smartlead tag" onClick={() => setMoveOpen(true)}><TagsIcon size={14} /> Move to tag</button>
          <WarmingButtons rows={selectedStatuses} onDone={() => setSelected(new Set())} />
          <button type="button" className="btn btn-sm" disabled={!replaceTargets.length} title="Swap the selected domains for free ones" onClick={() => setReplaceOpen(true)}><ArrowLeftRight size={14} /> Replace{replaceTargets.length ? ` (${replaceTargets.length})` : ""}</button>
          <button type="button" className="btn btn-sm" onClick={() => document.getElementById("plans-title")?.scrollIntoView({ behavior: "smooth" })}><Shuffle size={14} /> Daily plan</button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="btn btn-sm menu-trigger" disabled={acting || !smartleadConnected} title="Put a mark on the selected domains and their inboxes in Smartlead"><Tag size={14} /> Mark <ChevronDown size={13} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" side="top" align="center" sideOffset={10} style={{ minWidth: 210 }}>
                <DropdownMenu.Label className="menu-label">Mark as</DropdownMenu.Label>
                {MARK_CHOICES.map((m) => (
                  <DropdownMenu.Item key={m} className="menu-item" onSelect={() => act(() => markInboxes({ inboxIds: [...selected], mark: m, on: true }))}>{m}</DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Label className="menu-label">Remove mark</DropdownMenu.Label>
                {MARK_CHOICES.map((m) => (
                  <DropdownMenu.Item key={m} className="menu-item" onSelect={() => act(() => markInboxes({ inboxIds: [...selected], mark: m, on: false }))}>{m}</DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button type="button" className="btn btn-sm" title="Copy the selected inboxes' addresses, one per line"
            onClick={() => { void copyText(selectedRows.map((i) => i.email).join("\n")).then((ok) => { if (ok) toast.success(`Copied ${selectedRows.length} address${selectedRows.length === 1 ? "" : "es"}`); else toast.error("Couldn't copy: the browser blocked the clipboard"); }); }}>
            <Copy size={14} /> Copy emails
          </button>
          <button type="button" className="btn btn-sm" title="Copy the selected inboxes' domains, one per line" onClick={() => copyDomains(selectedRows.map((i) => i.domain))}>
            <Copy size={14} /> Copy domains
          </button>
          <span className="sep" />
          <button type="button" className="btn btn-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      ) : null}
      <MoveToTagDialog open={moveOpen} onOpenChange={setMoveOpen} domainIds={selectedDomains} inboxes={inboxes} dryRun={dryRun} appProblem={appProblem} onDone={() => setSelected(new Set())} />
      <ReplaceDialog open={replaceOpen} onOpenChange={setReplaceOpen} targets={replaceTargets} onDone={() => setSelected(new Set())} />
      <InboxSettingsDialog open={editOpen} onOpenChange={setEditOpen} inboxIds={[...selected]} domains={selectedDomains.length} current={current} selectedTags={selectedTags} knownTags={knownTags} dryRun={dryRun} appProblem={appProblem} />
    </div>
  );
}
