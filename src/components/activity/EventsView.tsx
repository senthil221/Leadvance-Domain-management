"use client";

import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, MailX, MessageSquareText, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadEvents, reclassifyReply } from "@/app/actions";
import { RangePicker } from "@/components/RangePicker";
import { ClientCell, Empty } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, bounceLine, bounceReason, type BounceReason } from "@/lib/bounces";
import { ago, int } from "@/lib/format";
import type { EventRow, EventsData } from "@/lib/queries";
import { REPLY_CLASS_META } from "@/lib/status";

// Replies or bounces for a date range, grouped client → domain, each level
// collapsible, with counts and rates against what the domain sent.

type Cls = keyof typeof REPLY_CLASS_META;
type Kind = "reply" | "bounce";
type Row = EventRow & { cat: string };

const REPLY_ORDER: Cls[] = ["human", "negative", "ooo", "auto"];
const catOf = (kind: Kind, e: EventRow) => (kind === "reply" ? e.replyClass ?? "unclassified" : bounceReason(e.bounceText));
const catMeta = (kind: Kind, c: string) =>
  kind === "reply" ? (REPLY_CLASS_META as Record<string, { label: string; tone: string }>)[c] ?? { label: "Unclassified", tone: "faint" } : BOUNCE_META[c as BounceReason];
/** The category the headline column counts: human replies, or bounces to addresses that don't exist. */
const KEY_CAT: Record<Kind, string> = { reply: "human", bounce: "missing" };

type Domain = { key: string; domainId: string | null; domain: string; rows: Row[]; sent: number; last: Date };
type Client = { key: string; name: string | null; hue: number | null; domains: Domain[]; count: number; keyCount: number; sent: number; last: Date };

// Fixed locale and zone, so the server and the browser render the same text.
const stamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

const rate = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(n && (100 * n) / d < 1 ? 2 : 1)}%` : "—");

function group(rows: Row[], sent: Record<string, number>, kind: Kind): Client[] {
  const clients = new Map<string, Client>();
  for (const r of rows) {
    const ck = r.clientId ?? "none";
    const c = clients.get(ck) ?? { key: ck, name: r.clientName, hue: r.clientHue, domains: [], count: 0, keyCount: 0, sent: 0, last: new Date(0) };
    let d = c.domains.find((x) => x.key === (r.domainId ?? r.domain ?? "?"));
    if (!d) {
      d = { key: r.domainId ?? r.domain ?? "?", domainId: r.domainId, domain: r.domain ?? "Unknown domain", rows: [], sent: r.domainId ? sent[r.domainId] ?? 0 : 0, last: new Date(0) };
      c.domains.push(d);
      c.sent += d.sent;
    }
    d.rows.push(r);
    const at = new Date(r.occurredAt);
    if (at > d.last) d.last = at;
    if (at > c.last) c.last = at;
    c.count++;
    if (r.cat === KEY_CAT[kind]) c.keyCount++;
    clients.set(ck, c);
  }
  const list = [...clients.values()];
  for (const c of list) c.domains.sort((a, b) => b.rows.length - a.rows.length || a.domain.localeCompare(b.domain));
  return list.sort((a, b) => b.count - a.count || (a.name ?? "~").localeCompare(b.name ?? "~"));
}

function Mix({ rows, kind }: { rows: Row[]; kind: Kind }) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);
  const order = kind === "reply" ? [...REPLY_ORDER, "unclassified"] : BOUNCE_ORDER;
  return (
    <span className="ev-mix">
      {order.filter((k) => counts.get(k)).map((k) => {
        const m = catMeta(kind, k);
        return <span key={k} className="ev-mix-item" title={m.label}><i className={`dot tone-${m.tone}`} />{counts.get(k)} {m.label.toLowerCase()}</span>;
      })}
    </span>
  );
}

export function EventsView({ kind, initial }: { kind: Kind; initial: EventsData }) {
  const [data, setData] = useState(initial);
  const [cat, setCat] = useState<string>("all");
  const [clientKey, setClientKey] = useState("");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [openDomains, setOpenDomains] = useState<Set<string> | "all">(initial.events.length <= 40 ? "all" : new Set());
  const [loading, start] = useTransition();
  const [, startReclass] = useTransition();
  const [overrides, setOverride] = useOptimistic(new Map<number, Cls>(), (m, [id, c]: [number, Cls]) => new Map(m).set(id, c));

  const load = (from: string, to: string) => start(async () => {
    const r = await loadEvents(kind, { from, to });
    if (r.ok) setData(r.data); else toast.error(r.error);
  });

  const rows: Row[] = useMemo(() => data.events.map((e) => {
    const x = { ...e, replyClass: overrides.get(e.id) ?? e.replyClass };
    return { ...x, cat: catOf(kind, x) };
  }), [data.events, overrides, kind]);
  const clientsAll = useMemo(() => group(rows, data.sent, kind), [rows, data.sent, kind]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.cat] = (c[r.cat] ?? 0) + 1;
    return c;
  }, [rows]);
  const tabs = kind === "reply"
    ? [...REPLY_ORDER.map((k) => ({ key: k, label: REPLY_CLASS_META[k].label })), { key: "all", label: "All" }]
    : [...BOUNCE_ORDER.map((k) => ({ key: k, label: BOUNCE_META[k].label })), { key: "all", label: "All" }];

  const needle = q.trim().toLowerCase();
  const clients = useMemo(() => {
    const shown = rows.filter((r) =>
      (cat === "all" || r.cat === cat) && (!clientKey || (r.clientId ?? "none") === clientKey) &&
      (!needle || [r.preview, r.leadEmail, r.leadName, r.domain, r.campaignName, r.inboxEmail, r.bounceText, r.clientName].some((v) => v?.toLowerCase().includes(needle))));
    return group(shown, data.sent, kind);
  }, [rows, cat, clientKey, needle, data.sent, kind]);
  const shownCount = clients.reduce((a, c) => a + c.count, 0);
  const domainCount = clients.reduce((a, c) => a + c.domains.length, 0);
  const totalSent = Object.values(data.sent).reduce((a, b) => a + b, 0);

  const isDomainOpen = (k: string) => openDomains === "all" || openDomains.has(k);
  const toggleDomain = (k: string) => setOpenDomains((s) => {
    const n = new Set(s === "all" ? clients.flatMap((c) => c.domains.map((d) => d.key)) : s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const toggleClient = (k: string) => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allOpen = closed.size === 0 && openDomains === "all";

  const reclassify = (r: Row, c: Cls) => startReclass(async () => {
    setOverride([r.id, c]);
    const res = await reclassifyReply(r.id, c);
    if (!res.ok) toast.error(res.error); else toast(`Marked as ${REPLY_CLASS_META[c].label.toLowerCase()}`);
  });

  const plural = (n: number) => (kind === "reply" ? (n === 1 ? "reply" : "replies") : n === 1 ? "bounce" : "bounces");
  const keyLabel = kind === "reply" ? "Human" : "No address";
  const rateLabel = kind === "reply" ? "Human rate" : "Bounce rate";
  const rateOf = (keyCount: number, count: number, sent: number) => (kind === "reply" ? rate(keyCount, sent) : rate(count, sent));

  return (
    <div className="flex flex-col gap-3">
      <div className="table-bar">
        <div className="view-tabs" role="tablist" aria-label={kind === "reply" ? "Reply type" : "Bounce reason"}>
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={cat === t.key} className={cat === t.key ? "is-on" : undefined} onClick={() => setCat(t.key)}>
              {t.label} <span>{int(counts[t.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        <RangePicker from={data.from} to={data.to} today={data.today} loading={loading} onChange={load} />
        {clientsAll.length > 1 ? (
          <select className="select" style={{ width: 150 }} value={clientKey} onChange={(e) => setClientKey(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clientsAll.map((c) => <option key={c.key} value={c.key}>{c.name ?? "No client"}</option>)}
          </select>
        ) : null}
        <span className="spacer-auto" />
        <button type="button" className="btn btn-sm" onClick={() => { if (allOpen) { setClosed(new Set(clients.map((c) => c.key))); setOpenDomains(new Set()); } else { setClosed(new Set()); setOpenDomains("all"); } }}>
          {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${kind === "reply" ? "replies" : "bounces"}`} />
        </label>
      </div>

      <div className="ev-summary">
        <span><b>{int(shownCount)}</b> {plural(shownCount)}</span>
        <span><b>{int(clients.reduce((a, c) => a + c.keyCount, 0))}</b> {kind === "reply" ? "human" : "to addresses that don't exist"}</span>
        <span><b>{int(domainCount)}</b> domain{domainCount === 1 ? "" : "s"} · <b>{int(clients.length)}</b> client{clients.length === 1 ? "" : "s"}</span>
        <span title="Campaign emails sent by all domains in this range">{kind === "reply" ? "human rate" : "bounce rate"} <b>{rateOf(clients.reduce((a, c) => a + c.keyCount, 0), shownCount, totalSent)}</b> of {int(totalSent)} sent</span>
      </div>

      <div className="ev-list">
        {clients.length === 0 ? (
          <Empty icon={kind === "reply" ? MessageSquareText : MailX} title={`No ${kind === "reply" ? "replies" : "bounces"} in this range`}>
            {kind === "reply" ? "Replies" : "Bounces"} arrive from the Smartlead webhook as they happen. Try a longer range.
          </Empty>
        ) : (
          <>
            <div className="ev-head" aria-hidden="true">
              <span>Client / domain</span>
              <span className="ev-num">{kind === "reply" ? "Replies" : "Bounces"}</span>
              <span className="ev-num">{keyLabel}</span>
              <span className="ev-num">Sent</span>
              <span className="ev-num">{rateLabel}</span>
              <span className="ev-num">Latest</span>
            </div>
            {clients.map((c) => {
              const cOpen = !closed.has(c.key);
              return (
                <Fragment key={c.key}>
                  <button type="button" className="ev-client" aria-expanded={cOpen} onClick={() => toggleClient(c.key)}>
                    <span className="ev-name">
                      <ChevronRight size={14} className="ev-chev" style={{ transform: cOpen ? "rotate(90deg)" : undefined }} />
                      <ClientCell name={c.name ?? "No client"} hue={c.hue} />
                      <span className="ev-sub">{c.domains.length} domain{c.domains.length === 1 ? "" : "s"}</span>
                    </span>
                    <span className="ev-num strong">{int(c.count)}</span>
                    <span className="ev-num">{c.keyCount ? int(c.keyCount) : <span className="zero">0</span>}</span>
                    <span className="ev-num text-muted">{c.sent ? int(c.sent) : <span className="zero">—</span>}</span>
                    <span className="ev-num">{rateOf(c.keyCount, c.count, c.sent)}</span>
                    <span className="ev-num text-muted">{ago(c.last)}</span>
                  </button>
                  {cOpen ? c.domains.map((d) => {
                    const dOpen = isDomainOpen(d.key);
                    const keyCount = d.rows.filter((r) => r.cat === KEY_CAT[kind]).length;
                    return (
                      <Fragment key={d.key}>
                        <button type="button" className="ev-domain" aria-expanded={dOpen} onClick={() => toggleDomain(d.key)}>
                          <span className="ev-name">
                            <ChevronRight size={13} className="ev-chev" style={{ transform: dOpen ? "rotate(90deg)" : undefined }} />
                            <span className="strong truncate">{d.domain}</span>
                            <Mix rows={d.rows} kind={kind} />
                          </span>
                          <span className="ev-num">{int(d.rows.length)}</span>
                          <span className="ev-num">{keyCount ? int(keyCount) : <span className="zero">0</span>}</span>
                          <span className="ev-num text-muted">{d.sent ? int(d.sent) : <span className="zero">—</span>}</span>
                          <span className="ev-num">{rateOf(keyCount, d.rows.length, d.sent)}</span>
                          <span className="ev-num text-muted">{ago(d.last)}</span>
                        </button>
                        {dOpen ? d.rows.map((r) => <EventLine key={r.id} r={r} kind={kind} onReclassify={reclassify} />) : null}
                      </Fragment>
                    );
                  }) : null}
                </Fragment>
              );
            })}
          </>
        )}
      </div>
      <p className="text-[12px] text-faint">
        Sent counts come from the daily Smartlead stats for the same days. {kind === "reply" ? "Change a reply's type from its badge; it also teaches the classifier." : "Reasons are read from each bounce notice."}
      </p>
    </div>
  );
}

function EventLine({ r, kind, onReclassify }: { r: Row; kind: Kind; onReclassify: (r: Row, c: Cls) => void }) {
  const at = new Date(r.occurredAt);
  const meta = catMeta(kind, r.cat);
  const who = r.leadName ? `${r.leadName} · ${r.leadEmail ?? ""}` : r.leadEmail ?? "Unknown lead";
  const text = kind === "reply" ? r.preview : bounceLine(r.bounceText);
  return (
    <div className="ev-row">
      <span className="ev-time" title={stamp.format(at) + " UTC"}>{ago(at)}</span>
      <span className="ev-lead truncate" title={who}>{who}</span>
      <span className="ev-text truncate" title={kind === "reply" ? r.preview ?? undefined : r.bounceText ?? undefined}>{text ?? <span className="zero">No preview</span>}</span>
      <span className="ev-ctx truncate" title={[r.campaignName, r.sequence ? `email ${r.sequence}` : null, r.inboxEmail ? `from ${r.inboxEmail}` : null].filter(Boolean).join(" · ")}>
        {r.campaignName ?? "—"}{r.sequence ? <span className="text-faint"> · #{r.sequence}</span> : null}
      </span>
      <span className="ev-badge">
        {kind === "reply" ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={`badge tone-${meta.tone} cursor-pointer`} aria-label="Change reply type">
                {meta.label} <ChevronDown size={11} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                <DropdownMenu.Label className="menu-label">Classify as</DropdownMenu.Label>
                {(Object.keys(REPLY_CLASS_META) as Cls[]).map((c) => (
                  <DropdownMenu.Item key={c} className="menu-item" onSelect={() => onReclassify(r, c)}>
                    <span className={`dot tone-${REPLY_CLASS_META[c].tone}`} />
                    {REPLY_CLASS_META[c].label}
                    {r.replyClass === c ? <Check size={13} className="menu-hint" /> : null}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : (
          <span className={`badge tone-${meta.tone}`} title={BOUNCE_META[r.cat as BounceReason].hint}>{meta.label}</span>
        )}
      </span>
      {r.link ? (
        <a className="ev-open" href={r.link} target="_blank" rel="noreferrer" title="Open in Smartlead" aria-label="Open in Smartlead"><ExternalLink size={13} /></a>
      ) : r.domainId ? (
        <Link className="ev-open" href={`/domains?d=${r.domainId}`} title="Open the domain" aria-label="Open the domain"><ExternalLink size={13} /></Link>
      ) : <span />}
    </div>
  );
}
