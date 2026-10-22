"use client";

import { Dialog, DropdownMenu } from "radix-ui";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Filter, MailX, MessageSquareText, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { loadEventDetail, loadEvents, reclassifyReply } from "@/app/actions";
import { RangePicker } from "@/components/RangePicker";
import { ClientCell, Empty, Skeleton } from "@/components/ui";
import { BOUNCE_META, BOUNCE_ORDER, bounceLine, bounceReason, type BounceReason } from "@/lib/bounces";
import type { ReplyClass } from "@/lib/classify";
import { int } from "@/lib/format";
import type { EventDetail, EventRow, EventsData } from "@/lib/queries";
import { REPLY_CLASS_META } from "@/lib/status";

// Replies or bounces for a date range: a few numbers, a client → domain rail
// to narrow down, a day-by-day list and a side panel with the full message.
// Types are tags; the filter picks which ones show.

type Kind = "reply" | "bounce";
type Row = EventRow & { tag: string };
type Meta = { label: string; tone: string };

const REPLY_TAGS = Object.keys(REPLY_CLASS_META) as ReplyClass[];
const POSITIVE = new Set(["human", "referral"]);
const NOT_A_FIT = new Set(["negative", "wrong_person", "unsubscribe"]);

const tagOf = (kind: Kind, e: EventRow) => (kind === "reply" ? e.replyClass ?? "human" : bounceReason(`${e.bounceRemote ?? ""} ${e.bounceText ?? ""}`));
const metaOf = (kind: Kind, t: string): Meta => (kind === "reply" ? (REPLY_CLASS_META as Record<string, Meta>)[t] : BOUNCE_META[t as BounceReason]) ?? { label: t, tone: "faint" };
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed((100 * n) / d < 1 ? 2 : 1)}%` : "—");
const companyOf = (email: string | null) => email?.split("@")[1]?.replace(/^mail\./, "") ?? null;
const initialsOf = (name: string | null, email: string | null) => {
  const s = (name ?? email ?? "?").trim();
  const parts = s.split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};

// Fixed locale and zone, so the server and the browser render the same text.
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const dayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const timeLabel = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const stamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

const PAGE = 200;

type DomainNode = { key: string; name: string; count: number; sent: number };
type ClientNode = { key: string; name: string; hue: number | null; count: number; sent: number; domains: DomainNode[] };

function tree(rows: Row[], sent: Record<string, number>): ClientNode[] {
  const clients = new Map<string, ClientNode>();
  for (const r of rows) {
    const ck = r.clientId ?? "none";
    const c = clients.get(ck) ?? { key: ck, name: r.clientName ?? "No client", hue: r.clientHue, count: 0, sent: 0, domains: [] };
    const dk = r.domainId ?? r.domain ?? "?";
    let d = c.domains.find((x) => x.key === dk);
    if (!d) {
      d = { key: dk, name: r.domain ?? "Unknown domain", count: 0, sent: r.domainId ? sent[r.domainId] ?? 0 : 0 };
      c.domains.push(d);
      c.sent += d.sent;
    }
    d.count++;
    c.count++;
    clients.set(ck, c);
  }
  const list = [...clients.values()];
  for (const c of list) c.domains.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function EventsView({ kind, initial }: { kind: Kind; initial: EventsData }) {
  const [data, setData] = useState(initial);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<{ client?: string; domain?: string }>({});
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, start] = useTransition();
  const [, startReclass] = useTransition();
  const [overrides, setOverride] = useOptimistic(new Map<number, ReplyClass>(), (m, [id, c]: [number, ReplyClass]) => new Map(m).set(id, c));

  const load = (from: string, to: string) => start(async () => {
    const r = await loadEvents(kind, { from, to });
    if (r.ok) { setData(r.data); setLimit(PAGE); } else toast.error(r.error);
  });

  const rows: Row[] = useMemo(() => data.events.map((e) => {
    const x = { ...e, replyClass: overrides.get(e.id) ?? e.replyClass };
    return { ...x, tag: tagOf(kind, x) };
  }), [data.events, overrides, kind]);

  // The rail and the numbers follow the type filter and search, not the rail's own selection.
  const needle = q.trim().toLowerCase();
  const matching = useMemo(() => rows.filter((r) =>
    (tags.size === 0 || tags.has(r.tag)) &&
    (!needle || [r.preview, r.leadEmail, r.leadName, r.domain, r.campaignName, r.bounceText, r.bounceRemote, r.clientName].some((v) => v?.toLowerCase().includes(needle)))), [rows, tags, needle]);
  const clients = useMemo(() => tree(matching, data.sent), [matching, data.sent]);
  const shown = useMemo(() => matching.filter((r) =>
    (!scope.client || (r.clientId ?? "none") === scope.client) && (!scope.domain || (r.domainId ?? r.domain ?? "?") === scope.domain)), [matching, scope]);

  const tagCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.tag, (c.get(r.tag) ?? 0) + 1);
    return c;
  }, [rows]);
  const order = kind === "reply" ? REPLY_TAGS : BOUNCE_ORDER;

  // Sent in scope, for rates.
  const sentInScope = scope.domain
    ? clients.flatMap((c) => c.domains).find((d) => d.key === scope.domain)?.sent ?? 0
    : scope.client ? clients.find((c) => c.key === scope.client)?.sent ?? 0
    : Object.values(data.sent).reduce((a, b) => a + b, 0);

  const days = useMemo(() => {
    const out: { key: string; label: string; rows: Row[] }[] = [];
    for (const r of shown.slice(0, limit)) {
      const at = new Date(r.occurredAt);
      const k = dayKey(at);
      let g = out[out.length - 1];
      if (!g || g.key !== k) {
        const diff = Math.round((Date.parse(data.today) - Date.parse(k)) / 86_400_000);
        g = { key: k, label: diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayLabel.format(at), rows: [] };
        out.push(g);
      }
      g.rows.push(r);
    }
    return out;
  }, [shown, limit, data.today]);

  const toggleTag = (t: string) => setTags((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const pickClient = (k: string) => {
    setScope((s) => (s.client === k && !s.domain ? {} : { client: k }));
    setOpenClients((s) => new Set(s).add(k));
  };
  const toggleOpen = (k: string) => setOpenClients((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const reclassify = (id: number, c: ReplyClass) => startReclass(async () => {
    setOverride([id, c]);
    const res = await reclassifyReply(id, c);
    if (!res.ok) toast.error(res.error); else toast(`Tagged ${REPLY_CLASS_META[c].label}`);
  });

  const count = (set: Set<string>) => shown.filter((r) => set.has(r.tag)).length;
  const cards = kind === "reply"
    ? [
        { label: "Replies", value: shown.length, foot: `${pct(shown.length, sentInScope)} of ${int(sentInScope)} sent`, set: null },
        { label: "Positive", value: count(POSITIVE), foot: `${pct(count(POSITIVE), sentInScope)} · interested and referrals`, set: POSITIVE, tone: "success" },
        { label: "Not a fit", value: count(NOT_A_FIT), foot: "not interested, wrong person, unsubscribe", set: NOT_A_FIT, tone: "warning" },
        { label: "Automatic", value: count(new Set(["ooo", "auto"])), foot: "out of office and auto-replies", set: new Set(["ooo", "auto"]) },
      ]
    : [
        { label: "Bounces", value: shown.length, foot: `${pct(shown.length, sentInScope)} of ${int(sentInScope)} sent`, set: null },
        { label: "Blocked", value: count(new Set(["blocked"])), foot: "spam, policy or sender block lists", set: new Set(["blocked"]), tone: "warning" },
        { label: "No such address", value: count(new Set(["missing"])), foot: "lead list quality", set: new Set(["missing"]) },
        { label: "Recipient side", value: count(new Set(["restricted", "full", "temporary", "other"])), foot: "rules, full mailboxes, delays", set: new Set(["restricted", "full", "temporary", "other"]) },
      ];
  const sameSet = (a: Set<string> | null) => (a === null ? tags.size === 0 : a.size === tags.size && [...a].every((x) => tags.has(x)));

  const current = selected != null ? rows.find((r) => r.id === selected) ?? null : null;
  const word = kind === "reply" ? "replies" : "bounces";

  return (
    <div className="flex flex-col gap-3">
      <div className="table-bar">
        <TagFilter kind={kind} order={order} counts={tagCounts} tags={tags} onToggle={toggleTag} onClear={() => setTags(new Set())} />
        <RangePicker from={data.from} to={data.to} today={data.today} loading={loading} onChange={load} />
        <span className="spacer-auto" />
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${word}`} />
        </label>
      </div>

      <section className="ev-cards" aria-label="Numbers">
        {cards.map((c) => (
          <button key={c.label} type="button" className="ev-card" aria-pressed={sameSet(c.set)} onClick={() => setTags(new Set(c.set ?? []))}>
            <span className="ev-card-label">{c.tone ? <i className={`dot tone-${c.tone}`} /> : null}{c.label}</span>
            <span className="ev-card-value">{int(c.value)}</span>
            <span className="ev-card-foot">{c.foot}</span>
          </button>
        ))}
      </section>

      <div className="ev-layout">
        <nav className="ev-rail" aria-label="Clients and domains">
          <button type="button" className="ev-rail-row is-all" aria-current={!scope.client || undefined} onClick={() => setScope({})}>
            <span className="truncate">All clients</span><span className="ev-rail-n">{int(matching.length)}</span>
          </button>
          {clients.map((c) => {
            const open = openClients.has(c.key) || scope.client === c.key;
            return (
              <div key={c.key}>
                <div className="ev-rail-client">
                  <button type="button" className="ev-rail-chev" aria-label={open ? `Hide ${c.name}'s domains` : `Show ${c.name}'s domains`} aria-expanded={open} onClick={() => toggleOpen(c.key)}>
                    <ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined }} />
                  </button>
                  <button type="button" className="ev-rail-row" aria-current={(scope.client === c.key && !scope.domain) || undefined} onClick={() => pickClient(c.key)}>
                    <ClientCell name={c.name} hue={c.hue} />
                    <span className="ev-rail-n">{int(c.count)}</span>
                  </button>
                </div>
                {open ? c.domains.map((d) => (
                  <button key={d.key} type="button" className="ev-rail-row is-domain" aria-current={scope.domain === d.key || undefined}
                    onClick={() => setScope((s) => (s.domain === d.key ? { client: c.key } : { client: c.key, domain: d.key }))}
                    title={`${d.count} of ${int(d.sent)} sent (${pct(d.count, d.sent)})`}>
                    <span className="truncate">{d.name}</span>
                    <span className="ev-rail-rate">{pct(d.count, d.sent)}</span>
                    <span className="ev-rail-n">{int(d.count)}</span>
                  </button>
                )) : null}
              </div>
            );
          })}
        </nav>

        <div className="ev-feed">
          {days.length === 0 ? (
            <Empty icon={kind === "reply" ? MessageSquareText : MailX} title={`No ${word} here`}>
              {tags.size || needle || scope.client ? "Nothing matches these filters." : `${kind === "reply" ? "Replies" : "Bounces"} arrive from the Smartlead webhook. Try a longer range.`}
            </Empty>
          ) : days.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h3 className="ev-day"><span>{g.label}</span><span>{g.rows.length}</span></h3>
              {g.rows.map((r) => {
                const m = metaOf(kind, r.tag);
                const text = kind === "reply" ? r.preview : bounceLine(r.bounceText, r.bounceRemote);
                return (
                  <button key={r.id} type="button" className="ev-item" aria-current={selected === r.id || undefined} onClick={() => setSelected(r.id)}>
                    <span className="ev-avatar" aria-hidden="true">{initialsOf(r.leadName, r.leadEmail)}</span>
                    <span className="ev-item-main">
                      <span className="ev-item-top">
                        <span className="ev-who">{r.leadName ?? r.leadEmail ?? "Unknown lead"}</span>
                        <span className="ev-company">{companyOf(r.leadEmail)}</span>
                      </span>
                      <span className="ev-snippet">{text ?? "No preview"}</span>
                    </span>
                    <span className="ev-item-side">
                      <span className={`badge tone-${m.tone}`}>{m.label}</span>
                      <span className="ev-item-meta">{r.domain ?? ""} · {timeLabel.format(new Date(r.occurredAt))}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
          {shown.length > limit ? (
            <button type="button" className="btn btn-sm ev-more" onClick={() => setLimit((l) => l + PAGE)}>Show {int(Math.min(PAGE, shown.length - limit))} more of {int(shown.length - limit)}</button>
          ) : null}
        </div>
      </div>

      <EventPanel kind={kind} row={current} onClose={() => setSelected(null)} onReclassify={reclassify} />
    </div>
  );
}

function TagFilter({ kind, order, counts, tags, onToggle, onClear }: {
  kind: Kind; order: readonly string[]; counts: Map<string, number>; tags: Set<string>; onToggle: (t: string) => void; onClear: () => void;
}) {
  const label = tags.size === 0 ? "All types" : tags.size === 1 ? metaOf(kind, [...tags][0]).label : `${tags.size} types`;
  return (
    <span className="flex items-center gap-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={`btn btn-sm${tags.size ? " is-on" : ""}`} aria-label="Filter by type">
            <Filter size={13} /> {label} <ChevronDown size={12} className="text-faint" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={6} style={{ minWidth: 220 }}>
            <DropdownMenu.Label className="menu-label">{kind === "reply" ? "Reply type" : "Bounce reason"}</DropdownMenu.Label>
            {order.map((t) => {
              const m = metaOf(kind, t);
              return (
                <DropdownMenu.CheckboxItem key={t} className="menu-item" checked={tags.has(t)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onToggle(t)}>
                  <span className={`dot tone-${m.tone}`} />
                  <span className="flex-1">{m.label}</span>
                  <span className="text-faint num">{int(counts.get(t) ?? 0)}</span>
                  <span className="w-4">{tags.has(t) ? <Check size={13} /> : null}</span>
                </DropdownMenu.CheckboxItem>
              );
            })}
            {tags.size ? (
              <>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item" onSelect={onClear}>Show all types</DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {tags.size ? <button type="button" className="btn btn-sm btn-icon" aria-label="Clear the type filter" onClick={onClear}><X size={13} /></button> : null}
    </span>
  );
}

function EventPanel({ kind, row, onClose, onReclassify }: { kind: Kind; row: Row | null; onClose: () => void; onReclassify: (id: number, c: ReplyClass) => void }) {
  const [detail, setDetail] = useState<{ id: number; d: EventDetail } | null>(null);
  const id = row?.id ?? null;
  useEffect(() => {
    if (id == null) return;
    let live = true;
    loadEventDetail(id).then((r) => {
      if (!live) return;
      if (r.ok) setDetail({ id, d: r.data }); else toast.error(r.error);
    });
    return () => { live = false; };
  }, [id]);
  const d = detail && row && detail.id === row.id ? detail.d : null;
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast("Copied"), () => toast.error("Couldn't copy"));

  return (
    // Not modal: the list stays usable, so the next reply is one click away.
    <Dialog.Root open={row !== null} onOpenChange={(o) => !o && onClose()} modal={false}>
      <Dialog.Portal>
        <Dialog.Content className="sheet" aria-describedby={undefined}
          onInteractOutside={(e) => { if ((e.target as Element | null)?.closest?.(".ev-item, .ev-rail, .ev-cards, .table-bar")) e.preventDefault(); }}
          onOpenAutoFocus={(e) => e.preventDefault()}>
          {row ? (
            <>
              <div className="sheet-head">
                <span className="ev-avatar is-lg" aria-hidden="true">{initialsOf(row.leadName, row.leadEmail)}</span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="sheet-title truncate">{row.leadName ?? row.leadEmail ?? "Unknown lead"}</Dialog.Title>
                  <p className="truncate text-[12.5px] text-muted">{row.leadEmail}{companyOf(row.leadEmail) ? ` · ${companyOf(row.leadEmail)}` : ""}</p>
                </div>
                <Dialog.Close asChild><button type="button" className="btn btn-sm btn-icon" aria-label="Close"><X size={15} /></button></Dialog.Close>
              </div>
              <div className="sheet-body">
                {kind === "reply" ? (
                  <div className="ev-tagset" role="group" aria-label="Reply type">
                    {REPLY_TAGS.map((t) => (
                      <button key={t} type="button" className={`ev-tagbtn tone-${REPLY_CLASS_META[t].tone}`} aria-pressed={row.tag === t} onClick={() => row.tag !== t && onReclassify(row.id, t)}>
                        {REPLY_CLASS_META[t].label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={`badge tone-${BOUNCE_META[row.tag as BounceReason].tone}`}>{BOUNCE_META[row.tag as BounceReason].label}</span>
                    <span className="text-[12.5px] text-muted">{BOUNCE_META[row.tag as BounceReason].hint}</span>
                  </div>
                )}

                <dl className="ev-facts">
                  <dt>Domain</dt><dd>{row.domainId ? <Link className="hover:underline" href={`/domains?d=${row.domainId}`}>{row.domain}</Link> : row.domain ?? "—"}</dd>
                  <dt>Client</dt><dd><ClientCell name={row.clientName} hue={row.clientHue} /></dd>
                  <dt>Inbox</dt><dd className="truncate">{row.inboxEmail ?? "—"}</dd>
                  <dt>Campaign</dt><dd className="truncate">{row.campaignName ?? "—"}{row.sequence ? ` · email ${row.sequence}` : ""}</dd>
                  <dt>{kind === "reply" ? "Replied" : "Bounced"}</dt><dd>{stamp.format(new Date(row.occurredAt))} UTC</dd>
                  {d?.ccs.length ? <><dt>Cc</dt><dd className="truncate">{d.ccs.join(", ")}</dd></> : null}
                </dl>

                {kind === "reply" ? (
                  <section>
                    <h4 className="ev-h">Their reply</h4>
                    {d ? <p className="ev-body">{d.body ?? row.preview ?? "No text"}</p> : <Skeleton w="100%" h={60} />}
                  </section>
                ) : (
                  <section>
                    <h4 className="ev-h">What the server said</h4>
                    {d ? (
                      <>
                        {d.remote ? <p className="ev-body is-code">{d.remote}</p> : null}
                        <p className="ev-body">{d.notice ?? row.bounceText ?? "No notice text"}</p>
                      </>
                    ) : <Skeleton w="100%" h={60} />}
                  </section>
                )}

                {d?.sent ? (
                  <details className="ev-sent">
                    <summary>Your email{d.sentSubject ? `: ${d.sentSubject}` : ""}</summary>
                    <p className="ev-body">{d.sent}</p>
                  </details>
                ) : null}
              </div>
              <div className="sheet-foot">
                {row.leadEmail ? <button type="button" className="btn" onClick={() => copy(row.leadEmail!)}><Copy size={14} /> Copy email</button> : null}
                {row.link ? <a className="btn btn-primary" href={row.link} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in Smartlead</a> : null}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
