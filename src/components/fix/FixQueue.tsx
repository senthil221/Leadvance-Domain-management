"use client";

import { AlarmClock, CircleCheck, Download, PlugZap, ShieldCheck, Sunrise, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { reconnectInboxes, snoozeFix, validateDns, wakeFix } from "@/app/actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { ClientCell, Empty } from "@/components/ui";
import { fixCsv, FIX_META, fixSummary, TIER_META, TIERS, type FixItem, type FixKind, type FixTier } from "@/lib/fix-queue";
import { ago, int } from "@/lib/format";
import type { FixQueueData } from "@/lib/queries";
import { Select } from "@/components/Select";

const SNOOZE_DAYS = [1, 3, 7, 14];

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** Every problem on the live domains, worst first, with what to do about each. */
export function FixQueue({ data, startClient = "", startKind = null }: { data: FixQueueData; startClient?: string; startKind?: FixKind | null }) {
  const router = useRouter();
  const [client, setClient] = useState(startClient);
  const [provider, setProvider] = useState("");
  const [pickedKind, setKind] = useState<FixKind | null>(startKind);
  const [tier, setTier] = useState<FixTier | "all">("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"open" | "snoozed">("open");
  const [busy, start] = useTransition();

  const narrow = <T extends FixItem>(list: T[]) => list.filter((i) =>
    (!client || i.clientId === client) && (!provider || i.provider === provider) && (!search || i.name.includes(search.trim().toLowerCase())));
  // The tiles count everything else that's filtered, so they don't change when one is picked.
  const scoped = useMemo(() => narrow(data.items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.items, client, provider, search]);
  const summary = useMemo(() => fixSummary(scoped), [scoped]);
  // A problem type that's no longer on the list (all snoozed, or none for this client) can't stay picked, with no chip to undo it.
  const kind = summary.kinds.some((k) => k.kind === pickedKind) ? pickedKind : null;
  const shown = useMemo(() => scoped.filter((i) => (tier === "all" || i.tier === tier) && (!kind || i.problems.some((p) => p.kind === kind))), [scoped, tier, kind]);
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

  const tiers = TIERS.filter((t) => shown.some((i) => i.tier === t));
  const synced = data.slSyncedAt ? ago(data.slSyncedAt) : null;

  return (
    <>
      <div className="stats">
        {TIERS.map((t) => (
          <button key={t} type="button" className={`stat fx-stat${tier === t ? " is-on" : ""}`} aria-pressed={tier === t} onClick={() => setTier(tier === t ? "all" : t)} title={TIER_META[t].hint}>
            <span className="stat-label"><span className={`fx-mark is-${t}`} aria-hidden="true" />{TIER_META[t].label}</span>
            <span className="stat-value">{int(summary.tiers[t].count)}</span>
            <span className="stat-foot">{summary.tiers[t].risk ? `${int(summary.tiers[t].risk)} emails a day at risk` : TIER_META[t].hint}</span>
          </button>
        ))}
        <div className="stat">
          <span className="stat-label">Emails a day at risk</span>
          <span className="stat-value">{int(summary.risk)}</span>
          <span className="stat-foot">{synced ? `Smartlead read ${synced}` : "Smartlead hasn't been read yet"}</span>
        </div>
      </div>

      <section className="card" aria-labelledby="fx-title">
        <div className="fx-bar">
          <div className="seg" role="group" aria-label="Open or snoozed">
            <button type="button" aria-pressed={view === "open"} onClick={() => setView("open")}>Open</button>
            <button type="button" aria-pressed={view === "snoozed"} onClick={() => setView("snoozed")}>Snoozed{data.snoozed.length ? ` (${int(data.snoozed.length)})` : ""}</button>
          </div>
          <Select className="select fx-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Select className="select fx-select" aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <input className="input fx-search" type="search" placeholder="Find a domain" aria-label="Find a domain" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="fx-actions">
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

        {view === "open" && summary.kinds.length ? (
          <div className="fx-kinds" role="group" aria-label="Filter by problem">
            {summary.kinds.map((k) => (
              <button key={k.kind} type="button" className={`fx-kind${kind === k.kind ? " is-on" : ""}`} aria-pressed={kind === k.kind} title={FIX_META[k.kind].hint} onClick={() => setKind(kind === k.kind ? null : k.kind)}>
                {FIX_META[k.kind].label}<span className="num">{int(k.count)}</span>
              </button>
            ))}
            {kind ? (
              <>
                <button type="button" className="fx-kind-clear" onClick={() => setKind(null)}><X size={12} strokeWidth={2} aria-hidden="true" />Show all</button>
                {shown.length ? (
                  <label className="fx-snooze-all">
                    <AlarmClock size={13} strokeWidth={1.75} aria-hidden="true" />
                    <Select className="select" aria-label={`Snooze every ${FIX_META[kind].label} problem shown`} value="" disabled={busy} onChange={(e) => { if (e.target.value) snooze(shown.map((i) => ({ name: i.name, kind })), Number(e.target.value)); }}>
                      <option value="">Snooze these {int(shown.length)}…</option>
                      {SNOOZE_DAYS.map((d) => <option key={d} value={d}>For {d} day{d === 1 ? "" : "s"}</option>)}
                    </Select>
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <h2 id="fx-title" className="sr-only">Problems to fix</h2>

        {view === "snoozed" ? (
          snoozed.length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Domain</th><th>Problem</th><th>What was seen</th><th>Back on</th><th /></tr></thead>
                <tbody>
                  {snoozed.map((i) => (
                    <tr key={`${i.name}|${i.top.kind}`}>
                      <td><DomainLink id={i.domainId} className="hover:underline">{i.name}</DomainLink></td>
                      <td>{i.top.label}</td>
                      <td className="fx-evidence">{i.top.evidence}</td>
                      <td className="num">{new Date(i.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                      <td className="is-num">
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
          <div className="table-scroll">
            <table className="data-table fx-table">
              <thead>
                <tr><th>Domain</th><th>Problem</th><th>Next step</th><th className="is-num" title="Emails a day that depend on this being fixed: what the domain sends, or what its inboxes could send">At risk a day</th><th><span className="sr-only">Snooze</span></th></tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <Fragment key={t}>
                    <tr className="fx-tier"><th colSpan={5} scope="rowgroup"><span className={`fx-mark is-${t}`} aria-hidden="true" />{TIER_META[t].label}<span className="fx-tier-hint">{TIER_META[t].hint}</span></th></tr>
                    {shown.filter((i) => i.tier === t).map((i) => (
                      <tr key={i.name}>
                        <td className="fx-domain">
                          <DomainLink id={i.domainId} className="fx-name">{i.name}</DomainLink>
                          <span className="fx-sub">
                            {i.clientId ? <Link href={`/clients/${i.clientId}`} className="hover:underline"><ClientCell name={i.clientName} hue={i.clientHue} /></Link> : <span className="zero">No client</span>}
                            {i.provider ? <span className="fx-provider">{i.provider}</span> : null}
                          </span>
                        </td>
                        <td className="fx-problem">
                          <b>{i.top.label}</b>
                          <span className="fx-evidence">{i.top.evidence}</span>
                          {i.problems.length > 1 ? (
                            <span className="fx-also">
                              {i.problems.slice(1).map((p) => <span key={p.kind} className="fx-chip" title={`${p.evidence}. ${p.next}.`}>{p.label}</span>)}
                            </span>
                          ) : null}
                        </td>
                        <td className="fx-next">{i.top.next}</td>
                        <td className="is-num fx-risk">
                          {i.risk ? <><span className="num">{int(i.risk)}</span><span className="fx-risk-track" aria-hidden="true"><span style={{ width: `${(100 * i.risk) / maxRisk}%` }} /></span></> : <span className="zero" title="Nothing sending through it, but you're paying for it">Unused</span>}
                        </td>
                        <td className="fx-snooze">
                          <Select className="select" aria-label={`Snooze ${i.top.label} on ${i.name}`} value="" disabled={busy} onChange={(e) => { if (e.target.value) snooze([{ name: i.name, kind: i.top.kind }], Number(e.target.value)); }}>
                            <option value="">Snooze</option>
                            {SNOOZE_DAYS.map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={CircleCheck} title={kind || tier !== "all" || client || provider || search ? "Nothing matches" : "Nothing to fix"}>
            {kind || tier !== "all" || client || provider || search ? "Nothing here with these filters." : "Every live domain looks healthy."}
          </Empty>
        )}
      </section>
    </>
  );
}
