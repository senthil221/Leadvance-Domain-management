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
import { ClientCell, Empty, Rep, StatusDot, TagList } from "@/components/ui";
import { InboxSettingsDialog } from "./InboxSettingsDialog";
import { MoveToTagDialog } from "./MoveToTagDialog";
import { PlansCard } from "./PlansCard";
import { ago, int } from "@/lib/format";
import type { ClientRow, InboxListRow, PlanRow } from "@/lib/queries";
import { DOMAIN_STATUSES, type DomainStatus } from "@/lib/status";

// Six views of the sending setup. Active and Disconnected list inboxes under
// their client and domain; the others list one line per domain.
// Domains in the warm-up programme (enrolled, not yet moved to a tag) live under
// Warming up only, and so do new domains that haven't started it yet (`fresh`).
// Cleanup lists domains with too many inboxes or several sender names (`crowded`),
// usually old inboxes left behind when a domain was renamed.
const warmingUp = (i: InboxListRow) => i.domainWarmupStartedAt != null && i.domainWarmupDoneAt == null;
type Sets = { fresh: Set<string>; crowded: Set<string> };
type Match = (i: InboxListRow, s: Sets) => boolean;
const TABS: readonly { key: "active" | "warming" | "attention" | "cleanup" | "disconnected" | "all"; label: string; match: Match }[] = [
  { key: "active", label: "Active", match: (i, s) => i.status === "connected" && i.domainStatus === "active" && !warmingUp(i) && !s.fresh.has(i.domainId) },
  { key: "warming", label: "Warming up", match: (i, s) => (warmingUp(i) || s.fresh.has(i.domainId)) && i.status !== "removed" },
  { key: "attention", label: "Needs attention", match: (i, s) => (i.domainStatus === "active" || i.domainStatus === "warming") && !warmingUp(i) && !s.fresh.has(i.domainId) },
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
type TabKey = (typeof TABS)[number]["key"];
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
  return r;
}

type Group = {
  domainId: string; domain: string; status: DomainStatus; clientName: string | null; clientHue: number | null;
  inboxes: InboxListRow[];
  count: number; warmupOff: number; avgWarmup: number | null; avgLimit: number | null; capacity: number;
  avgRep: number | null; minRep: number | null; lowRep: number; campaigns: number;
  sent7: number; replies7: number; human7: number; bounces7: number;
  sentToday: number; avgWait: number | null; pending: number; tags: string[]; esp: string | null;
  domainTags: string[]; graceDaysLeft: number | null; alerts: number;
  warm: { day: number; days: number; ready: boolean; left: number; pct: number } | null;
  ageDays: number | null; dns: Dns; bl: number | null; blListings: string[]; blocked: number; paused: number; disconnected: number;
  /** Inboxes by sender name, most first; `added` is the earliest inbox's age in days. */
  senders: { name: string; ids: string[]; added: number | null }[];
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
    };
  });
}

/**
 * Domains rolled up into one row with the same columns: sums for counts,
 * averages over inboxes for rates, and how many domains have a problem. Used
 * for a client and for a tag inside a client.
 */
type ClientGroup = Group & { key: string; domains: Group[]; dnsBad: number; listed: number; tagGroups: ClientGroup[] | null };
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
    case "status": return DOMAIN_STATUSES.indexOf(g.status);
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
    case "campaigns": return i.campaigns;
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
  { key: "blacklist", label: "Blacklist" }, { key: "connection", label: "Connection" },
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
const ageLabel = (days: number | null) => (days == null ? null : days < 60 ? `${days}d` : days < 730 ? `${Math.round(days / 30)}mo` : `${(days / 365).toFixed(1)}y`);

/** A healthy value: quiet, so problems in the same column stand out. */
function Ok({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="ok-cell" title={title}>{children}</span>;
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
type Stage = "dns" | "ready" | "warming" | "done";
const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: "dns", label: "Waiting for DNS", hint: "New domains whose SPF, DKIM, DMARC or MX isn't found yet. Warm-up starts once all four are." },
  { key: "ready", label: "Ready to start", hint: "DNS is valid. Starts by itself when automatic warm-up is on, or with Start warm-up." },
  { key: "warming", label: "Warming", hint: "Warm-up running: counting the days set in Settings → Warming up." },
  { key: "done", label: "Done", hint: "Warm-up days are up. Move them to a tag to put them to work." },
];
const stageOf = (g: Group): Stage => (g.warm ? (g.warm.ready ? "done" : "warming") : g.dns.state === "ok" ? "ready" : "dns");

/** One segment per warm-up day: done days filled, today lit, the rest empty. */
function WarmTrack({ g }: { g: Group }) {
  const stage = stageOf(g);
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

export function InboxesView({ inboxes, clients, plans, smartleadConnected, dryRun, timezone, appProblem, newMaxAgeDays, inboxLimit }: {
  inboxes: InboxListRow[]; clients: ClientRow[]; plans: PlanRow[]; smartleadConnected: boolean; dryRun: boolean; timezone: string;
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
  const [q, setQ] = useState("");
  const [clientId, setClientId] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "domain", dir: 1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const [esp, setEsp] = useState("");
  const [acting, startAct] = useTransition();
  const act = (fn: () => Promise<{ ok: true; data: { message: string } } | { ok: false; error: string }>) =>
    startAct(async () => { const r = await fn(); if (r.ok) toast.success(r.data.message); else toast.error(r.error); });
  const cols = useColumns("inboxes", COLUMNS);
  const on = cols.on;
  const esps = useMemo(() => [...new Set(inboxes.map((i) => i.providerType).filter((x): x is string => Boolean(x)))].sort(), [inboxes]);

  const base = useMemo(() => {
    const client = clients.find((c) => c.id === clientId)?.name;
    return inboxes.filter((i) => (!client || i.clientName === client) && (!esp || i.providerType === esp));
  }, [inboxes, clients, clientId, esp]);
  const [limitText, setLimitText] = useState(String(inboxLimit));
  const fresh = useMemo<Sets>(() => ({ fresh: freshDomains(inboxes, newMaxAgeDays), crowded: crowdedDomains(inboxes, inboxLimit) }), [inboxes, newMaxAgeDays, inboxLimit]);
  const attentionCount = useMemo(() => group(base.filter(tabMatch("attention", fresh))).filter((g) => reasonsOf(g).length > 0).length, [base, fresh]);
  const lowRepInboxes = useMemo(() => base.filter((i) => i.status === "connected" && i.warmupReputation != null && i.warmupReputation < 90).length, [base]);
  // Domains in every view but Disconnected, which counts inboxes.
  const counts = useMemo(() => {
    const domains = (k: TabKey) => new Set(base.filter(tabMatch(k, fresh)).map((i) => i.domainId)).size;
    return { active: domains("active"), warming: domains("warming"), attention: attentionCount, cleanup: domains("cleanup"), disconnected: base.filter(tabMatch("disconnected", fresh)).length, all: domains("all") } as Record<TabKey, number>;
  }, [base, attentionCount, fresh]);

  const groups = useMemo(() => {
    const match = tabMatch(tab, fresh);
    const needle = q.trim().toLowerCase();
    const shown = base.filter((i) => match(i) && (!needle || i.email.includes(needle) || i.domain.includes(needle) || i.senderName?.toLowerCase().includes(needle) || i.smartleadTags.some((t) => t.toLowerCase().includes(needle))));
    return group(shown).filter((g) => tab !== "attention" || reasonsOf(g).length > 0).sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      if (x === y) return a.domain.localeCompare(b.domain);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [base, tab, q, sort, fresh]);

  // The Warming up tab's domains by stage, before the stage filter.
  const warmStages = useMemo(() => {
    const by: Record<Stage, string[]> = { dns: [], ready: [], warming: [], done: [] };
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

  const clientGroups = useMemo(() => byClient(groups).sort((a, b) => {
    // Clients follow the same sort as their domains; by name otherwise, "No client" last.
    const byName = (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.domain.localeCompare(b.domain);
    if (sort.key === "domain" || sort.key === "client") return byName * (sort.key === "client" ? sort.dir : 1);
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    if (x === y) return byName;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sort.dir;
  }), [groups, sort]);
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

  const selectedRows = useMemo(() => inboxes.filter((i) => selected.has(i.id)), [inboxes, selected]);
  const selectedDomains = useMemo(() => [...new Set(selectedRows.map((i) => i.domainId))], [selectedRows]);
  const replaceTargets = useMemo(() => selectedDomains.flatMap((id) => {
    const i = selectedRows.find((x) => x.domainId === id)!;
    return i.domainStatus === "active" || i.domainStatus === "warming" ? [{ id, name: i.domain, tld: i.domainTld, clientName: i.clientName, clientHue: i.clientHue }] : [];
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
  const allIds = all.map((i) => i.id);
  const allSel = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSel = allIds.some((id) => selected.has(id));

  const colCount = 2 + COLUMNS.filter((col) => on(col.key)).length;
  const allOpen = clientGroups.length > 0 && clientGroups.every((c) => openClients.has(c.key));
  const flip = (id: string) => (s: Set<string>) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const toggle = (id: string) => setOpen(flip(id));
  const toggleClient = (key: string) => setOpenClients(flip(key));
  const toggleTag = (key: string) => setOpenTags(flip(key));
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "domain" || key === "client" ? 1 : -1 }));

  // The cells a client or tag row shares: totals for the group, each marked Sum or Avg.
  const summaryCells = (c: ClientGroup) => (
    <>
      {on("status") ? <td /> : null}
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
          <td className="col-check" onClick={(e) => { e.stopPropagation(); toggleIds(ids); }}>
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
          {on("status") ? <td><StatusDot status={g.status} /></td> : null}
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
            {on("connection") ? <td>{i.status === "disconnected" ? <span className="ns-status tone-danger" title={i.connectError ?? undefined}>{i.connectError ? i.connectError.slice(0, 32) : "Disconnected"}</span> : <Ok>Connected</Ok>}</td> : null}
          </tr>
        )) : null}
      </Fragment>
    );
  });

  return (
    <div className="flex flex-col gap-3">
      {!smartleadConnected ? (
        <div className="callout tone-info">
          <Info size={15} strokeWidth={1.75} />
          <span>
            Showing the last synced settings. Add your Smartlead API key in <Link href="/settings" className="underline">Settings</Link> to
            change warmup and daily limits from here.
          </span>
        </div>
      ) : null}

      <section className="stats" aria-label="Inbox numbers">
        <div className="stat"><span className="stat-label">Inboxes</span><span className="stat-value">{int(totals.inboxes)}</span><span className="stat-foot">on {int(groups.length)} domains · {groups.length ? (totals.inboxes / groups.length).toFixed(1) : "0"} per domain</span></div>
        <div className="stat"><span className="stat-label">Campaign emails / day</span><span className="stat-value">{int(totals.capacity)}</span><span className="stat-foot">{totals.inboxes ? (totals.capacity / totals.inboxes).toFixed(1) : "0"} per inbox on average</span></div>
        <div className="stat"><span className="stat-label">Warmup emails / day</span><span className="stat-value">{int(totals.warmup)}</span><span className="stat-foot">{int(all.filter((i) => !i.warmupEnabled).length)} inboxes with warmup off</span></div>
        <div className="stat"><span className="stat-label">Average reputation</span><span className="stat-value">{totals.avgRep == null ? "—" : totals.avgRep.toFixed(1)}</span><span className="stat-foot">{int(lowRepInboxes)} connected inboxes under 90</span></div>
      </section>

      <div className="table-bar">
        <div className="view-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : undefined} onClick={() => setTab(t.key)}>
              {t.label} <span>{int(counts[t.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        <select className="select" style={{ width: 160 }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={esp} onChange={(e) => setEsp(e.target.value)} aria-label="Filter by ESP">
          <option value="">All ESPs</option>
          {esps.map((x) => <option key={x} value={x}>{espLabel(x)}</option>)}
        </select>
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search inboxes" />
        </label>
        {FLAT.includes(tab) ? null : <button type="button" className="btn btn-sm" aria-label={allOpen ? "Collapse all" : "Expand all"} title={allOpen ? "Collapse all" : "Expand all"} onClick={() => { setOpenClients(allOpen ? new Set() : new Set(clientGroups.map((c) => c.key))); setOpenTags(allOpen ? new Set() : new Set(clientGroups.flatMap((c) => c.tagGroups?.map((t) => t.key) ?? []))); }}>
          {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        </button>}
        <button type="button" className="btn btn-sm" disabled={acting} title="Check SPF, DKIM, DMARC and MX now (selected domains, or all sending domains)" onClick={() => act(() => validateDns(selectedDomains))}>
          <ShieldCheck size={14} /> Validate DNS{selectedDomains.length ? ` (${selectedDomains.length})` : ""}
        </button>
        <button type="button" className="btn btn-sm" disabled={acting || Boolean(appProblem)} title={appProblem ?? "Ask Smartlead to retry the login of every disconnected inbox"} onClick={() => act(reconnectInboxes)}>
          <PlugZap size={14} /> Reconnect{inboxes.filter((i) => i.status === "disconnected").length ? ` (${inboxes.filter((i) => i.status === "disconnected").length})` : ""}
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
        <div className="cl-bar">
          <span className="cl-bar-text">
            Domains with more than
            <input className="input num cl-limit" inputMode="numeric" value={limitText} aria-label="Inbox limit per domain"
              onChange={(e) => setLimitText(e.target.value)}
              onBlur={() => { const n = Number(limitText); if (n && n !== inboxLimit) act(async () => { const r = await saveInboxLimit(n); return r.ok ? { ok: true as const, data: { message: `Limit set to ${n} inboxes a domain` } } : r; }); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            inboxes, or inboxes under more than one sender name. Click a sender to select its inboxes, then copy their addresses.
          </span>
        </div>
      ) : null}

      {tab === "warming" ? (
        <div className="wu-summary" role="group" aria-label="Warm-up stages">
          {STAGES.map((s) => (
            <button key={s.key} type="button" className={`wu-stage is-${s.key}`} aria-pressed={stage === s.key} title={s.hint}
              onClick={() => setStage((x) => (x === s.key ? null : s.key))}>
              <span className="wu-stage-label"><i />{s.label}</span>
              <span className="wu-stage-n">{int(warmStages[s.key].length)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="table-wrap">
        <div className="table-scroll" style={{ maxHeight: "calc(100dvh - 270px)", minHeight: 260 }}>
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
                {groups.filter((g) => !stage || stageOf(g) === stage).map((g) => {
                  const ids = g.inboxes.map((x) => x.id);
                  const gSel = ids.every((id) => selected.has(id));
                  const gSome = ids.some((id) => selected.has(id));
                  return (
                    <tr key={g.domainId} className="is-clickable" data-selected={gSel} onClick={() => toggleIds(ids)}>
                      <td className="col-check">
                        <input type="checkbox" className="checkbox" checked={gSel} ref={(el) => { if (el) el.indeterminate = !gSel && gSome; }} onChange={() => {}} aria-label={`Select inboxes on ${g.domain}`} tabIndex={-1} />
                      </td>
                      <td className="col-first">
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
                            <TagList tags={g.domainTags} graceDaysLeft={g.graceDaysLeft} />
                          </span>
                          <span className="wu-sub">{g.clientName ?? "No client"}{g.esp ? ` · ${espLabel(g.esp)}` : ""}</span>
                        </span>
                      </td>
                      <td className="wu-col-track"><WarmTrack g={g} /></td>
                      <td className="is-num" title={g.ageDays != null ? `${g.ageDays} days since the first inbox was added to Smartlead` : "Not known yet"}>{g.ageDays == null ? <span className="zero">—</span> : `${g.ageDays}d`}</td>
                      <td><DnsCell dns={g.dns} /></td>
                      <td><WarmupCell blocked={g.blocked} paused={g.paused} total={g.count} /></td>
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
                        <span className="flex flex-col gap-0.5">
                          <DomainLink id={g.domainId} tab="inboxes" className="strong hover:underline">{g.domain}</DomainLink>
                          <span className="wu-sub">{g.clientName ?? "No client"}{g.esp ? ` · ${espLabel(g.esp)}` : ""}</span>
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
                      <td><StatusDot status={g.status} /></td>
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
                    <tr key={g.domainId} className="is-clickable" data-selected={gSel} onClick={() => toggleIds(ids)}>
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
                      <td><StatusDot status={g.status} /></td>
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
                {on("connection") ? <SortTh k="connection" sort={sort} onSort={sortBy}>Connection</SortTh> : null}
              </tr>
            </thead>
            <tbody>
              {clientGroups.map((c) => {
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
            onClick={() => { void navigator.clipboard.writeText(selectedRows.map((i) => i.email).join("\n")).then(() => toast.success(`Copied ${selectedRows.length} address${selectedRows.length === 1 ? "" : "es"}`)); }}>
            <Copy size={14} /> Copy emails
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
