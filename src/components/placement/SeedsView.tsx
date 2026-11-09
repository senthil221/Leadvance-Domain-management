"use client";

import { ChevronRight, FlaskConical, RefreshCw, Search } from "lucide-react";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { Empty } from "@/components/ui";
import { ago, int, summarize } from "@/lib/format";
import { EXCLUDED, FRESH_DAYS, STATUS_HINT, STATUS_LABEL, seedStatus, type MxProvider, type SeedStatus } from "@/lib/placement-seeds";

export type SeedItem = {
  email: string; domain: string; name: string | null; source: "reply" | "untracked"; excerpt: string | null; forwards: boolean;
  firstReplyAt: string; lastReplyAt: string; autoReplies: number; campaignName: string | null; client: string | null;
  personRepliedAt: string | null; bouncedAt: string | null;
  provider: MxProvider | null; providerName: string | null; mxHost: string | null; checkedAt: string | null;
};

type Tab = "ready" | "recheck" | "outlook" | "other" | "excluded" | "all";

const TABS: { key: Tab; label: string; title: string }[] = [
  { key: "ready", label: "Ready", title: STATUS_HINT.ready },
  { key: "recheck", label: "Re-check", title: STATUS_HINT.recheck },
  { key: "outlook", label: "Microsoft", title: STATUS_HINT.outlook },
  { key: "other", label: "Other", title: `${STATUS_HINT.other}. Also seeds not looked up yet` },
  { key: "excluded", label: "Excluded", title: "Forwarded, a person replied, bounced, or the company has no mail server. Never used in a test" },
  { key: "all", label: "All", title: "Every seed found" },
];

const TONE: Partial<Record<SeedStatus, string>> = {
  ready: " tone-success", recheck: " tone-info", forwards: " tone-warning", person: " tone-danger", bounced: " tone-danger", no_mx: " tone-danger",
};

const inTab = (tab: Tab, s: SeedStatus) =>
  tab === "all" ? true : tab === "excluded" ? EXCLUDED.includes(s) : tab === "other" ? s === "other" || s === "unknown" : s === tab;

function stamp(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function SeedsView({ seeds, lastSync }: {
  seeds: SeedItem[];
  lastSync: { finishedAt: string | null; ok: boolean | null; error: string | null } | null;
}) {
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("ready");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rows = useMemo(() => seeds.map((s) => ({ ...s, status: seedStatus(s, now) })), [seeds, now]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(TABS.map((t) => [t.key, 0])) as Record<Tab, number>;
    for (const r of rows) for (const t of TABS) if (inTab(t.key, r.status)) c[t.key]++;
    return c;
  }, [rows]);
  // Seeds at one company sit behind the same filter, so companies matter as much as addresses.
  const companies = useMemo(() => new Set(rows.filter((r) => r.status === "ready").map((r) => r.domain)).size, [rows]);
  const recheckCompanies = useMemo(() => new Set(rows.filter((r) => r.status === "recheck").map((r) => r.domain)).size, [rows]);

  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => inTab(tab, r.status)
    && (!needle || [r.email, r.name, r.domain, r.providerName, r.client, r.campaignName, r.excerpt].some((v) => v?.toLowerCase().includes(needle))));

  const checkNow = () => start(async () => {
    const r = await runJobNow("placement-seeds");
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Seeds: ${summarize(r.data) ?? "done"}`);
  });

  return (
    <div className="ur">
      <div className="ur-bar">
        <div className="seg" role="group" aria-label="Which seeds">
          {TABS.map((t) => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)} title={t.title}>
              {t.label} {int(counts[t.key])}
            </button>
          ))}
        </div>
        <span className="spacer-auto" />
        <dl className="inb-kpis" aria-label="Seed numbers">
          <div className="inb-kpi" title={STATUS_HINT.ready}><dt>Ready</dt><dd>{int(counts.ready)}</dd></div>
          <div className="inb-kpi" title="Different companies among the ready seeds: seeds at one company share its spam filter"><dt>Companies</dt><dd>{int(companies)}</dd></div>
          <div className="inb-kpi" title={`${STATUS_HINT.recheck}. At ${int(recheckCompanies)} companies`}><dt>Re-check</dt><dd>{int(counts.recheck)}</dd></div>
          <div className="inb-kpi" title={STATUS_HINT.outlook}><dt>Microsoft</dt><dd>{int(counts.outlook)}</dd></div>
        </dl>
        <span className={`ur-sync${lastSync?.ok === false ? " is-bad" : ""}`} title={lastSync?.error ?? "Replies are read for new seeds every hour"}>
          {lastSync?.finishedAt ? `Read ${ago(lastSync.finishedAt, now)}` : "Not read yet"}{lastSync?.ok === false ? " · failed" : ""}
        </span>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={checkNow} title="Look for new seeds and their mail servers now">
          <RefreshCw size={13} className={pending ? "spin" : undefined} /> {pending ? "Reading…" : "Check now"}
        </button>
      </div>

      <div className="ur-bar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search address, company, provider or text" aria-label="Search seeds" />
        </label>
        <span className="ur-sub" style={{ flex: "1 1 260px", minWidth: 0 }}>
          Only Google seeds count in a test: Google skips the auto-reply when the mail went to spam, Microsoft sends it even from Junk.
        </span>
        <span className="ur-sync">{int(shown.length)} shown</span>
      </div>

      <div className="table-wrap ur-wrap">
        <div className="table-scroll">
          <table className="data-table is-main ur-table">
            <colgroup>
              <col style={{ width: 28 }} /><col style={{ width: "26%" }} /><col style={{ width: "20%" }} /><col style={{ width: 170 }} />
              <col style={{ width: 130 }} /><col />
            </colgroup>
            <thead>
              <tr><th aria-label="Open" /><th>Seed</th><th>Company mail</th><th>Status</th><th>Last auto-reply</th><th>Seen on</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open === r.email;
                return (
                  <Fragment key={r.email}>
                    <tr className="is-clickable" data-selected={isOpen} onClick={() => setOpen(isOpen ? null : r.email)}>
                      <td className="ur-caret"><ChevronRight size={14} className={isOpen ? "is-open" : undefined} /></td>
                      <td>
                        <div className="ur-two">
                          <span className="strong ur-clip">{r.email}</span>
                          <span className="ur-sub ur-clip">{r.excerpt ?? (r.name ? r.name : "—")}</span>
                        </div>
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-clip">{r.domain}</span>
                          <span className="ur-sub ur-clip" title={r.mxHost ?? undefined}>{r.providerName ?? (r.provider === "none" ? "No MX" : "Not looked up yet")}</span>
                        </div>
                      </td>
                      <td><span className={`badge${TONE[r.status] ?? ""}`} title={STATUS_HINT[r.status]}>{STATUS_LABEL[r.status]}</span></td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-when" title={stamp(r.lastReplyAt)}>{ago(r.lastReplyAt, now)}</span>
                          <span className="ur-sub">{int(r.autoReplies)} auto-repl{r.autoReplies === 1 ? "y" : "ies"}</span>
                        </div>
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-clip">{r.client ?? <span className="zero">No client</span>}</span>
                          <span className="ur-sub ur-clip">{r.campaignName ?? (r.source === "untracked" ? "Untracked reply" : "—")}</span>
                        </div>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="ur-open">
                        <td />
                        <td colSpan={5}>
                          <div className="ur-msg">
                            <div className="ur-msg-head">
                              <span><b>{r.name ? `${r.name} <${r.email}>` : r.email}</b></span>
                              <span className="ur-sub">
                                First auto-reply {stamp(r.firstReplyAt)} · last {stamp(r.lastReplyAt)}
                                {r.mxHost ? ` · mail goes to ${r.mxHost}` : ""}
                                {r.personRepliedAt ? ` · a person replied ${stamp(r.personRepliedAt)}` : ""}
                                {r.bouncedAt ? ` · bounced ${stamp(r.bouncedAt)}` : ""}
                              </span>
                            </div>
                            <pre className="ur-body">{r.excerpt ?? "No text kept for this auto-reply."}</pre>
                            <span className="ur-sub">{STATUS_HINT[r.status]}.</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 ? (
            <Empty icon={FlaskConical} title={seeds.length ? (rows.some((r) => inTab(tab, r.status)) ? "Nothing matches" : `No ${TABS.find((t) => t.key === tab)!.label.toLowerCase()} seeds`) : "No seeds yet"}>
              {seeds.length
                ? `Ready seeds use Google mail and auto-replied in the last ${FRESH_DAYS} days.`
                : "Auto-replies saying the person has left (\"no longer with the company\", \"this mailbox is not monitored\") are collected from campaign and untracked replies every hour."}
            </Empty>
          ) : null}
        </div>
      </div>
    </div>
  );
}
