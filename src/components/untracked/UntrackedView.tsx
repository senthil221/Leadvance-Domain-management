"use client";

import { ChevronRight, MailQuestion, RefreshCw, Search } from "lucide-react";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { Select } from "@/components/Select";
import { Empty } from "@/components/ui";
import { ago, int, summarize } from "@/lib/format";

export type UntrackedItem = {
  id: string; subject: string | null; senderName: string | null; senderEmail: string | null;
  recipientName: string | null; recipientEmail: string | null; body: string | null;
  receivedAt: string | null; firstSeenAt: string; handledAt: string | null;
  client: string | null; domain: string | null;
};

const DAY = 86_400_000;
const when = (r: UntrackedItem) => r.receivedAt ?? r.firstSeenAt;

/** "Nov 9, 14:05" in the viewer's time. */
function stamp(d: string) {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function UntrackedView({ rows, lastSync, handledDays }: {
  rows: UntrackedItem[];
  lastSync: { finishedAt: string | null; ok: boolean | null; error: string | null } | null;
  handledDays: number;
}) {
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<"open" | "handled">("open");
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const waiting = useMemo(() => rows.filter((r) => !r.handledAt), [rows]);
  const handled = useMemo(() => rows.filter((r) => r.handledAt), [rows]);
  const clients = useMemo(() => [...new Set(rows.map((r) => r.client ?? ""))].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1)), [rows]);
  const today = waiting.filter((r) => now - new Date(when(r)).getTime() < DAY).length;
  const week = waiting.filter((r) => now - new Date(when(r)).getTime() < 7 * DAY).length;
  const oldest = waiting.reduce<string | null>((a, r) => (!a || when(r) < a ? when(r) : a), null);

  const needle = q.trim().toLowerCase();
  const shown = (tab === "open" ? waiting : handled).filter((r) =>
    (client === "" || (r.client ?? "") === client)
    && (!needle || [r.subject, r.senderName, r.senderEmail, r.recipientEmail, r.client, r.domain, r.body].some((v) => v?.toLowerCase().includes(needle))));

  const checkNow = () => start(async () => {
    const r = await runJobNow("untracked-replies");
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Smartlead read: ${summarize(r.data) ?? "done"}`);
  });

  return (
    <div className="ur">
      <div className="ur-bar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sender, subject, inbox or text" aria-label="Search replies" />
        </label>
        <div className="seg" role="group" aria-label="Waiting or handled">
          <button type="button" aria-pressed={tab === "open"} onClick={() => setTab("open")}>Waiting {int(waiting.length)}</button>
          <button type="button" aria-pressed={tab === "handled"} onClick={() => setTab("handled")} title={`Left Smartlead's untracked list in the last ${handledDays} days`}>Handled {int(handled.length)}</button>
        </div>
        <Select className="select" style={{ width: 150 }} value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c || "none"} value={c}>{c || "No client"}</option>)}
        </Select>
        <span className="spacer-auto" />
        <dl className="inb-kpis" aria-label="Untracked reply numbers">
          <div className="inb-kpi"><dt>Waiting</dt><dd>{int(waiting.length)}</dd></div>
          <div className="inb-kpi"><dt>Today</dt><dd>{int(today)}</dd></div>
          <div className="inb-kpi"><dt>Last 7 days</dt><dd>{int(week)}</dd></div>
          <div className="inb-kpi" title={oldest ? `Oldest still waiting: ${stamp(oldest)}` : undefined}><dt>Oldest</dt><dd>{oldest ? ago(oldest, now) : "—"}</dd></div>
        </dl>
        <span className={`ur-sync${lastSync?.ok === false ? " is-bad" : ""}`} title={lastSync?.error ?? "Smartlead is read every 15 minutes"}>
          {lastSync?.finishedAt ? `Read ${ago(lastSync.finishedAt, now)}` : "Not read yet"}{lastSync?.ok === false ? " · failed" : ""}
        </span>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={checkNow} title="Read Smartlead's untracked replies now">
          <RefreshCw size={13} className={pending ? "spin" : undefined} /> {pending ? "Reading…" : "Check now"}
        </button>
      </div>

      <div className="table-wrap ur-wrap">
        <div className="table-scroll">
          <table className="data-table is-main ur-table">
            <colgroup>
              <col style={{ width: 28 }} /><col style={{ width: 128 }} /><col style={{ width: "22%" }} /><col /><col style={{ width: "20%" }} />
              {tab === "handled" ? <col style={{ width: 110 }} /> : null}
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Open" /><th>Received</th><th>From</th><th>Subject</th><th>To</th>
                {tab === "handled" ? <th>Handled</th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open === r.id;
                const fresh = !r.handledAt && now - new Date(when(r)).getTime() < DAY;
                return (
                  <Fragment key={r.id}>
                    <tr className="is-clickable" data-selected={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                      <td className="ur-caret"><ChevronRight size={14} className={isOpen ? "is-open" : undefined} /></td>
                      <td className="ur-when" title={stamp(when(r))}>
                        {fresh ? <i className="ur-new" aria-label="Today" /> : null}{ago(when(r), now)}
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="strong ur-clip">{r.senderName ?? r.senderEmail ?? "Unknown sender"}</span>
                          {r.senderName && r.senderEmail ? <span className="ur-sub ur-clip">{r.senderEmail}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-clip">{r.subject ?? <span className="zero">(no subject)</span>}</span>
                          {r.body ? <span className="ur-sub ur-clip">{r.body.replace(/\s+/g, " ").slice(0, 220)}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-clip">{r.recipientEmail ?? "—"}</span>
                          <span className="ur-sub ur-clip">{[r.client, r.domain].filter(Boolean).join(" · ") || "Inbox not in the app"}</span>
                        </div>
                      </td>
                      {tab === "handled" ? <td className="ur-sub">{r.handledAt ? ago(r.handledAt, now) : "—"}</td> : null}
                    </tr>
                    {isOpen ? (
                      <tr className="ur-open">
                        <td />
                        <td colSpan={tab === "handled" ? 5 : 4}>
                          <div className="ur-msg">
                            <div className="ur-msg-head">
                              <span><b>{r.senderName ?? r.senderEmail}</b>{r.senderName ? ` <${r.senderEmail}>` : ""}</span>
                              <span className="ur-sub">to {r.recipientName ? `${r.recipientName} <${r.recipientEmail}>` : r.recipientEmail} · {stamp(when(r))}</span>
                            </div>
                            <pre className="ur-body">{r.body ?? "Smartlead sent no text for this reply."}</pre>
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
            <Empty icon={MailQuestion} title={tab === "open" ? (rows.length ? "Nothing matches" : "No untracked replies") : "Nothing handled lately"}>
              {tab === "open"
                ? "Replies Smartlead can't tie to a campaign lead show up here within 15 minutes, and in the account managers' sheet."
                : `Replies that left Smartlead's untracked list in the last ${handledDays} days show here.`}
            </Empty>
          ) : null}
        </div>
      </div>
    </div>
  );
}
