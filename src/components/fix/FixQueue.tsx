"use client";

import { Dialog } from "radix-ui";
import { AlarmClock, ArrowUpRight, ChevronRight, CircleCheck, Download, PlugZap, ShieldCheck, Sunrise, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { reconnectInboxes, snoozeFix, validateDns, wakeFix } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { SortTh, type SortState } from "@/components/SortTh";
import { Badge, ClientCell, Empty } from "@/components/ui";
import { fixCsv, FIX_META, fixSummary, TIER_META, TIERS, type FixItem, type FixKind, type FixTier } from "@/lib/fix-queue";
import { ago, int } from "@/lib/format";
import type { FixQueueData } from "@/lib/queries";
import type { Tone } from "@/lib/status";
import { Select } from "@/components/Select";

const SNOOZE_DAYS = [1, 3, 7, 14];
const TIER_TONE: Record<FixTier, Tone> = { urgent: "danger", soon: "warning", watch: "faint" };
const TIER_RANK: Record<FixTier, number> = { urgent: 0, soon: 1, watch: 2 };

/** At-risk bands for the filter: emails a day that depend on the fix. */
const RISKS = [
  { key: "1000", label: "1,000+ a day", test: (r: number) => r >= 1000 },
  { key: "100", label: "100–999 a day", test: (r: number) => r >= 100 && r < 1000 },
  { key: "low", label: "Under 100 a day", test: (r: number) => r > 0 && r < 100 },
  { key: "unused", label: "Unused", test: (r: number) => r === 0 },
] as const;
type RiskKey = (typeof RISKS)[number]["key"];

type SortKey = "domain" | "issue" | "status" | "client" | "provider" | "risk";

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** Every problem on the live domains, worst first: one domain a row, the whole story in a side panel. */
export function FixQueue({ data, startClient = "", startKind = null }: { data: FixQueueData; startClient?: string; startKind?: FixKind | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [client, setClient] = useState(startClient);
  const [provider, setProvider] = useState("");
  const [pickedKind, setKind] = useState<FixKind | null>(startKind);
  const [tier, setTier] = useState<FixTier | "all">("all");
  const [risk, setRisk] = useState<RiskKey | "">("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"open" | "snoozed">("open");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "status", dir: 1 });
  const [openName, setOpenName] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const narrow = <T extends FixItem>(list: T[]) => list.filter((i) =>
    (!client || i.clientId === client) && (!provider || i.provider === provider) && (!search || i.name.includes(search.trim().toLowerCase())));
  // The tiles count everything else that's filtered, so they don't change when one is picked.
  const scoped = useMemo(() => narrow(data.items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.items, client, provider, search]);
  const summary = useMemo(() => fixSummary(scoped), [scoped]);
  // A problem type that's no longer on the list (all snoozed, or none for this client) can't stay picked.
  const kind = summary.kinds.some((k) => k.kind === pickedKind) ? pickedKind : null;
  const riskTest = RISKS.find((r) => r.key === risk)?.test;
  const filtered = useMemo(() => scoped.filter((i) => (tier === "all" || i.tier === tier) && (!kind || i.problems.some((p) => p.kind === kind)) && (!riskTest || riskTest(i.risk))),
    [scoped, tier, kind, riskTest]);
  const shown = useMemo(() => {
    const val = (i: FixItem): string | number => {
      switch (sort.key) {
        case "domain": return i.name;
        case "issue": return i.top.label;
        case "client": return i.clientName ?? "￿";
        case "provider": return i.provider ?? "￿";
        case "risk": return i.risk;
        default: return TIER_RANK[i.tier];
      }
    };
    // Status keeps the queue's own order (worst first) within each tier.
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c * sort.dir;
    });
  }, [filtered, sort]);
  const snoozed = useMemo(() => narrow(data.snoozed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.snoozed, client, provider, search]);

  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of [...data.items, ...data.snoozed]) if (i.clientId) m.set(i.clientId, i.clientName ?? "");
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.items, data.snoozed]);
  const providers = useMemo(() => [...new Set([...data.items, ...data.snoozed].map((i) => i.provider).filter((p): p is string => !!p))].sort(), [data.items, data.snoozed]);
  const maxRisk = Math.max(1, ...shown.map((i) => i.risk));

  const disconnected = scoped.filter((i) => i.problems.some((p) => p.kind === "disconnected")).length;
  const dnsIds = scoped.filter((i) => i.problems.some((p) => p.kind === "dns_down" || p.kind === "dns_records")).map((i) => i.domainId);

  const run = (work: () => Promise<{ ok: true; data?: { message?: string } | undefined } | { ok: false; error: string }>, done?: string) => start(async () => {
    const r = await work();
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.data?.message ?? done ?? "Done");
    router.refresh();
  });
  const snooze = (rows: { name: string; kind: FixKind }[], days: number) => run(() => snoozeFix({ rows, days }), `Snoozed ${rows.length === 1 ? rows[0].name : `${int(rows.length)} problems`} for ${days} day${days === 1 ? "" : "s"}`);
  const sortBy = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: k === "risk" ? -1 : 1 }));

  const synced = data.slSyncedAt ? ago(data.slSyncedAt) : null;
  const filtersOn = !!(kind || tier !== "all" || client || provider || search || risk);
  const clearAll = () => { setKind(null); setTier("all"); setClient(""); setProvider(""); setSearch(""); setRisk(""); };
  const open = openName ? data.items.find((i) => i.name === openName) ?? null : null;
  const openDomain = (id: string) => {
    setOpenName(null);
    const p = new URLSearchParams(window.location.search);
    p.set("d", id);
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  };

  return (
    <>
      <div className="fx-sum" role="group" aria-label="Summary">
        <button type="button" className="fx-tile" data-on={tier === "all" && view === "open" ? "" : undefined} onClick={() => { setTier("all"); setView("open"); }}>
          <span className="fx-tile-label">Open fixes</span>
          <span className="fx-tile-n">{int(scoped.length)}</span>
          <span className="fx-tile-sub">{int(summary.risk)} emails a day at risk</span>
        </button>
        {TIERS.map((t) => (
          <button key={t} type="button" className={`fx-tile is-${t}`} data-on={tier === t && view === "open" ? "" : undefined} aria-pressed={tier === t}
            title={TIER_META[t].hint} onClick={() => { setView("open"); setTier(tier === t ? "all" : t); }}>
            <span className="fx-tile-label"><span className={`fx-mark is-${t}`} aria-hidden="true" />{TIER_META[t].label}</span>
            <span className="fx-tile-n">{int(summary.tiers[t].count)}</span>
            <span className="fx-tile-sub">{summary.tiers[t].risk ? `${int(summary.tiers[t].risk)} a day at risk` : TIER_META[t].hint}</span>
          </button>
        ))}
        <button type="button" className="fx-tile is-snoozed" data-on={view === "snoozed" ? "" : undefined} onClick={() => setView(view === "snoozed" ? "open" : "snoozed")}>
          <span className="fx-tile-label"><AlarmClock size={12} strokeWidth={1.75} aria-hidden="true" />Snoozed</span>
          <span className="fx-tile-n">{int(snoozed.length)}</span>
          <span className="fx-tile-sub">{synced ? `Smartlead read ${synced}` : "Smartlead not read yet"}</span>
        </button>
      </div>

      <section className="card fx-card" aria-labelledby="fx-title">
        <div className="fx-bar">
          <input className="input fx-search" type="search" placeholder="Find a domain" aria-label="Find a domain" value={search} onChange={(e) => setSearch(e.target.value)} />
          {view === "open" ? (
            <>
              <Select className="select fx-select" aria-label="Status" value={tier} onChange={(e) => setTier(e.target.value as FixTier | "all")}>
                <option value="all">Any status</option>
                {TIERS.map((t) => <option key={t} value={t}>{TIER_META[t].label} ({int(summary.tiers[t].count)})</option>)}
              </Select>
              <Select className="select fx-select" aria-label="Issue" value={kind ?? ""} onChange={(e) => setKind((e.target.value || null) as FixKind | null)}>
                <option value="">Any issue</option>
                {summary.kinds.map((k) => <option key={k.kind} value={k.kind}>{FIX_META[k.kind].label} ({int(k.count)})</option>)}
              </Select>
              <Select className="select fx-select" aria-label="At risk" value={risk} onChange={(e) => setRisk(e.target.value as RiskKey | "")}>
                <option value="">Any risk</option>
                {RISKS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </Select>
            </>
          ) : null}
          <Select className="select fx-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select className="select fx-select" aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          {filtersOn ? <button type="button" className="fx-clear" onClick={clearAll}><X size={12} strokeWidth={2} aria-hidden="true" />Clear</button> : null}
          <span className="fx-actions">
            {view === "open" && kind && shown.length ? (
              <Select className="select fx-select" aria-label={`Snooze every ${FIX_META[kind].label} problem shown`} value="" disabled={busy}
                onChange={(e) => { if (e.target.value) snooze(shown.map((i) => ({ name: i.name, kind })), Number(e.target.value)); }}>
                <option value="">Snooze these {int(shown.length)}…</option>
                {SNOOZE_DAYS.map((d) => <option key={d} value={d}>For {d} day{d === 1 ? "" : "s"}</option>)}
              </Select>
            ) : null}
            {dnsIds.length ? (
              <button type="button" className="btn btn-sm" disabled={busy} title="Check the nameservers and records of these domains again now" onClick={() => run(() => validateDns(dnsIds))}>
                <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />Re-check DNS ({int(dnsIds.length)})
              </button>
            ) : null}
            {disconnected ? (
              <button type="button" className="btn btn-sm" disabled={busy} title="Ask Smartlead to retry every failed inbox on your account, not only these" onClick={() => run(() => reconnectInboxes())}>
                <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />Reconnect in Smartlead
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={() => download("fix-queue.csv", fixCsv(shown))}>
              <Download size={14} strokeWidth={1.75} aria-hidden="true" />CSV
            </button>
          </span>
        </div>

        <h2 id="fx-title" className="sr-only">Problems to fix</h2>

        {view === "snoozed" ? (
          snoozed.length ? (
            <div className="table-scroll fx-scroll">
              <table className="data-table fx-snz">
                <thead><tr><th>Domain</th><th>Issue</th><th>What was seen</th><th>Client</th><th className="is-num">Back on</th><th><span className="sr-only">Bring back</span></th></tr></thead>
                <tbody>
                  {snoozed.map((i) => (
                    <tr key={`${i.name}|${i.top.kind}`}>
                      <td className="fx-c-domain"><DomainLink id={i.domainId} className="fx-name">{i.name}</DomainLink></td>
                      <td className="fx-c-issue">{i.top.label}</td>
                      <td className="fx-c-text" title={i.top.evidence}>{i.top.evidence}</td>
                      <td className="fx-c-client">{i.clientId ? <ClientCell name={i.clientName} hue={i.clientHue} /> : <span className="zero">No client</span>}</td>
                      <td className="is-num">{new Date(i.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                      <td className="fx-c-act">
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => wakeFix({ name: i.name, kind: i.top.kind }), `${i.name} is back on the queue`)}>
                          <Sunrise size={13} strokeWidth={1.75} aria-hidden="true" />Bring back
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={AlarmClock} title="Nothing snoozed">Snooze a problem you can&apos;t get to yet, and it comes back when the time is up.</Empty>
        ) : shown.length ? (
          <div className="table-scroll fx-scroll">
            <table className="data-table fx-table">
              <thead>
                <tr>
                  <SortTh k="domain" sort={sort} onSort={sortBy}>Domain</SortTh>
                  <SortTh k="issue" sort={sort} onSort={sortBy}>Issue</SortTh>
                  <SortTh k="status" sort={sort} onSort={sortBy} title="How soon to fix it">Status</SortTh>
                  <th>Next step</th>
                  <SortTh k="client" sort={sort} onSort={sortBy}>Client</SortTh>
                  <SortTh k="provider" sort={sort} onSort={sortBy}>Provider</SortTh>
                  <SortTh k="risk" sort={sort} onSort={sortBy} num title="Emails a day that depend on this being fixed: what the domain sends, or what its inboxes could send">At risk a day</SortTh>
                  <th><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => {
                  const more = i.problems.length - 1;
                  return (
                    <tr key={i.name} className="is-clickable" data-active={openName === i.name ? "true" : undefined} tabIndex={0}
                      onClick={() => setOpenName(i.name)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenName(i.name); } }}>
                      <td className="fx-c-domain"><span className="fx-name" title={i.name}>{i.name}</span></td>
                      <td className="fx-c-issue" title={i.problems.map((p) => `${p.label}: ${p.evidence}`).join("\n")}>
                        <span className="fx-issue">{i.top.label}</span>
                        {more ? <span className="fx-more">+{more} more</span> : null}
                      </td>
                      <td className="fx-c-status"><Badge tone={TIER_TONE[i.tier]}>{TIER_META[i.tier].label}</Badge></td>
                      <td className="fx-c-text" title={i.top.next}>{i.top.next}</td>
                      <td className="fx-c-client">{i.clientId ? <ClientCell name={i.clientName} hue={i.clientHue} /> : <span className="zero">No client</span>}</td>
                      <td className="fx-c-provider">{i.provider ?? <span className="zero">—</span>}</td>
                      <td className="is-num fx-c-risk">
                        {i.risk ? (
                          <span className="fx-risk"><span className="fx-risk-track" aria-hidden="true"><span style={{ width: `${(100 * i.risk) / maxRisk}%` }} /></span><span className="num">{int(i.risk)}</span></span>
                        ) : <span className="zero" title="Nothing sending through it, but you're paying for it">Unused</span>}
                      </td>
                      <td className="fx-c-act"><ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={CircleCheck} title={filtersOn ? "Nothing matches" : "Nothing to fix"}>
            {filtersOn ? "Nothing here with these filters." : "Every live domain looks healthy."}
          </Empty>
        )}
        {view === "open" && shown.length ? <div className="fx-foot">{int(shown.length)} of {int(scoped.length)} domains · click a row for every issue and what to do</div> : null}
      </section>

      <Dialog.Root open={!!open} onOpenChange={(o) => !o && setOpenName(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" style={{ background: "transparent", backdropFilter: "none" }} />
          <Dialog.Content className="sheet fx-sheet" aria-describedby={undefined}>
            {open ? (
              <>
                <div className="sheet-head">
                  <div className="fx-sheet-who">
                    <Dialog.Title className="sheet-title truncate">{open.name}</Dialog.Title>
                    <div className="fx-sheet-meta">
                      <Badge tone={TIER_TONE[open.tier]}>{TIER_META[open.tier].label}</Badge>
                      {open.clientId ? <Link href={`/clients/${open.clientId}`} className="hover:underline"><ClientCell name={open.clientName} hue={open.clientHue} /></Link> : <span className="zero">No client</span>}
                      {open.provider ? <span>{open.provider}</span> : null}
                    </div>
                  </div>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn" aria-label="Close"><X size={16} strokeWidth={1.5} /></button>
                  </Dialog.Close>
                </div>
                <div className="sheet-body">
                  <dl className="fx-facts">
                    <div><dt>At risk a day</dt><dd>{open.risk ? int(open.risk) : "Unused"}</dd></div>
                    <div><dt>Issues</dt><dd>{int(open.problems.length)}</dd></div>
                    <div><dt>Status</dt><dd>{TIER_META[open.tier].hint}</dd></div>
                  </dl>
                  <ol className="fx-problems">
                    {open.problems.map((p) => (
                      <li key={p.kind} className="fx-problem">
                        <div className="fx-problem-head">
                          <span className={`fx-mark is-${p.tier}`} aria-hidden="true" />
                          <b>{p.label}</b>
                          <Badge tone={TIER_TONE[p.tier]}>{TIER_META[p.tier].label}</Badge>
                          <span className="fx-problem-risk">{p.risk ? `${int(p.risk)} a day` : ""}</span>
                        </div>
                        <p className="fx-seen">{p.evidence}</p>
                        <p className="fx-do"><span>Next step</span>{p.next}</p>
                        <div className="fx-problem-act">
                          <Select className="select fx-select" aria-label={`Snooze ${p.label} on ${open.name}`} value="" disabled={busy}
                            onChange={(e) => { if (e.target.value) { snooze([{ name: open.name, kind: p.kind }], Number(e.target.value)); } }}>
                            <option value="">Snooze this…</option>
                            {SNOOZE_DAYS.map((d) => <option key={d} value={d}>For {d} day{d === 1 ? "" : "s"}</option>)}
                          </Select>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="sheet-foot">
                  <button type="button" className="btn btn-sm" onClick={() => openDomain(open.domainId)}>
                    Open domain<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
