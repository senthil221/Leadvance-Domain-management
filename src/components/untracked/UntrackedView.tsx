"use client";

import { CalendarDays, ChevronRight, ClipboardCopy, MailQuestion, RefreshCw, Search } from "lucide-react";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { runJobNow } from "@/app/actions";
import { MultiSelect } from "@/components/MultiSelect";
import { Select } from "@/components/Select";
import { Empty } from "@/components/ui";
import { ago, int, summarize } from "@/lib/format";
import { PRESETS, fmt, presetRange, type PresetKey } from "@/lib/range";

export type UntrackedItem = {
  id: string; kind: "reply" | "bounce" | "other"; subject: string | null; senderName: string | null; senderEmail: string | null;
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

/** The day a reply came in, YYYY-MM-DD in UTC: the same date the sheet gets. */
const day = (r: UntrackedItem) => new Date(when(r)).toISOString().slice(0, 10);

/** A sheet cell holds at most 50,000 characters. */
const CELL_MAX = 49_000;

/** Replies as rows Google Sheets pastes into its columns: sender email, recipient email, recipient name, subject, body, date. */
function sheetRows(rows: UntrackedItem[]) {
  return rows.map((r) => [r.senderEmail, r.recipientEmail, r.recipientName, r.subject, (r.body ?? "").trim().slice(0, CELL_MAX), day(r)].map((v) => v ?? ""));
}
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const toHtml = (rows: string[][]) =>
  `<table>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v).replace(/\r?\n/g, "<br>")}</td>`).join("")}</tr>`).join("")}</table>`;
/** Tab-separated, with a field quoted when it holds a tab, a line break or a quote, as Sheets reads it. */
const toTsv = (rows: string[][]) =>
  rows.map((r) => r.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");

type Tab = "all" | "replies" | "other" | "handled";
type DateKey = "any" | PresetKey;

export function UntrackedView({ all, other, counts, lastSync, handledDays }: {
  /** Every reply to a campaign email ("Re: For …") kept, waiting or handled. The waiting ones are what the sheet gets. */
  all: UntrackedItem[];
  /** Waiting bounces, warm-up and stray mail: the latest only. */
  other: UntrackedItem[];
  counts: { all: number; replies: number; other: number; handled: number };
  lastSync: { finishedAt: string | null; ok: boolean | null; error: string | null } | null;
  handledDays: number;
}) {
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("replies");
  const [q, setQ] = useState("");
  const [clients, setClients] = useState<string[]>([]);
  const [dateKey, setDateKey] = useState<DateKey>("any");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const replies = useMemo(() => all.filter((r) => !r.handledAt), [all]);
  const handled = useMemo(() => all.filter((r) => r.handledAt && now - new Date(r.handledAt).getTime() < handledDays * DAY), [all, now, handledDays]);

  const rows = tab === "all" ? all : tab === "replies" ? replies : tab === "other" ? other : handled;
  const clientOptions = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of rows) n.set(r.client ?? "", (n.get(r.client ?? "") ?? 0) + 1);
    return [...n].sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1)).map(([c, count]) => ({ value: c, label: c || "No client", count }));
  }, [rows]);
  const today = replies.filter((r) => now - new Date(when(r)).getTime() < DAY).length;
  const week = replies.filter((r) => now - new Date(when(r)).getTime() < 7 * DAY).length;
  const oldest = replies.reduce<string | null>((a, r) => (!a || when(r) < a ? when(r) : a), null);

  const todayUtc = fmt(new Date(now));
  const pickDate = (k: DateKey) => {
    setDateKey(k);
    const r = k === "any" ? null : presetRange(k, todayUtc);
    if (r) { setFrom(r[0]); setTo(r[1]); } else if (k === "any") { setFrom(""); setTo(""); }
  };

  const needle = q.trim().toLowerCase();
  const picked = new Set(clients);
  const shown = rows.filter((r) =>
    (picked.size === 0 || picked.has(r.client ?? ""))
    && (!from || day(r) >= from) && (!to || day(r) <= to)
    && (!needle || [r.subject, r.senderName, r.senderEmail, r.recipientEmail, r.client, r.domain, r.body].some((v) => v?.toLowerCase().includes(needle))));

  const copy = async () => {
    const data = sheetRows(shown);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([toHtml(data)], { type: "text/html" }),
          "text/plain": new Blob([toTsv(data)], { type: "text/plain" }),
        })]);
      } else await navigator.clipboard.writeText(toTsv(data));
      toast.success(`Copied ${int(data.length)} ${data.length === 1 ? "reply" : "replies"}. Click a cell in the sheet and paste`);
    } catch {
      toast.error("The browser wouldn't let the page copy. Try again");
    }
  };

  const checkNow = () => start(async () => {
    const r = await runJobNow("untracked-replies");
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Smartlead read: ${summarize(r.data) ?? "done"}`);
  });

  return (
    <div className="ur">
      <div className="ur-bar">
        <div className="seg" role="group" aria-label="Which replies">
          <button type="button" aria-pressed={tab === "all"} onClick={() => setTab("all")}
            title="Every reply to a campaign email the app has kept, waiting or handled">All replies {int(counts.all)}</button>
          <button type="button" aria-pressed={tab === "replies"} onClick={() => setTab("replies")}
            title="Replies to campaign emails (subject Re: For …) still in Smartlead's untracked list. These go to the sheet">Replies {int(counts.replies)}</button>
          <button type="button" aria-pressed={tab === "other"} onClick={() => setTab("other")}
            title="Bounce notices, warm-up and other mail in the untracked list. Kept out of the sheet">Bounces &amp; other {int(counts.other)}</button>
          <button type="button" aria-pressed={tab === "handled"} onClick={() => setTab("handled")}
            title={`Campaign replies that left Smartlead's untracked list in the last ${handledDays} days`}>Handled {int(counts.handled)}</button>
        </div>
        <span className="spacer-auto" />
        <dl className="inb-kpis" aria-label="Untracked reply numbers">
          <div className="inb-kpi" title="Campaign replies waiting"><dt>Waiting</dt><dd>{int(counts.replies)}</dd></div>
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

      <div className="ur-bar">
        <label className="search-input">
          <Search size={14} strokeWidth={1.5} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sender, subject, inbox or text" aria-label="Search replies" />
        </label>
        <MultiSelect options={clientOptions} value={clients} onChange={setClients} allLabel="All clients" aria-label="Filter by client" style={{ minWidth: 140 }} />
        <span className="ur-date">
          <CalendarDays size={14} strokeWidth={1.5} className="text-faint" aria-hidden />
          <Select className="select" style={{ width: 120 }} value={dateKey} onChange={(e) => pickDate(e.target.value as DateKey)} aria-label="Received" data-on={dateKey !== "any"}>
            <option value="any">Any date</option>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>
          {dateKey === "custom" ? (
            <>
              <input type="date" className="input" value={from} max={to || todayUtc} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
              <span className="text-faint">–</span>
              <input type="date" className="input" value={to} min={from || undefined} max={todayUtc} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            </>
          ) : null}
        </span>
        {clients.length || dateKey !== "any" || q ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setClients([]); pickDate("any"); setQ(""); }}>Clear</button>
        ) : null}
        <span className="spacer-auto" />
        <span className="ur-sync">{int(shown.length)} shown</span>
        <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={copy}
          title="Copy the replies shown, newest first, as sheet rows: sender email, recipient email, recipient name, subject, body, date">
          <ClipboardCopy size={13} /> Copy for Sheets
        </button>
      </div>

      <div className="table-wrap ur-wrap">
        <div className="table-scroll">
          <table className="data-table is-main ur-table">
            <colgroup>
              <col style={{ width: 28 }} /><col style={{ width: 128 }} /><col style={{ width: "22%" }} /><col /><col style={{ width: "20%" }} />
              {tab === "handled" || tab === "all" ? <col style={{ width: 110 }} /> : null}
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Open" /><th>Received</th><th>From</th><th>Subject</th><th>To</th>
                {tab === "handled" || tab === "all" ? <th>Handled</th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open === r.id;
                const fresh = tab === "replies" && now - new Date(when(r)).getTime() < DAY;
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
                          <span className="ur-clip">
                            {tab === "other" ? <span className={`badge${r.kind === "bounce" ? " tone-danger" : ""} ur-kind`}>{r.kind === "bounce" ? "Bounce" : "Other"}</span> : null}
                            {r.subject ?? <span className="zero">(no subject)</span>}
                          </span>
                          {r.body ? <span className="ur-sub ur-clip">{r.body.replace(/\s+/g, " ").slice(0, 220)}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="ur-two">
                          <span className="ur-clip">{r.recipientEmail ?? "—"}</span>
                          <span className="ur-sub ur-clip">{[r.client, r.domain].filter(Boolean).join(" · ") || "Inbox not in the app"}</span>
                        </div>
                      </td>
                      {tab === "handled" || tab === "all" ? <td className="ur-sub">{r.handledAt ? ago(r.handledAt, now) : tab === "all" ? "Waiting" : "—"}</td> : null}
                    </tr>
                    {isOpen ? (
                      <tr className="ur-open">
                        <td />
                        <td colSpan={tab === "handled" || tab === "all" ? 5 : 4}>
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
          {tab === "other" && counts.other > other.length && shown.length ? (
            <p className="ur-more">The latest {int(other.length)} of {int(counts.other)} shown.</p>
          ) : null}
          {shown.length === 0 ? (
            <Empty icon={MailQuestion} title={rows.length ? "Nothing matches" : tab === "all" || tab === "replies" ? "No untracked replies" : tab === "other" ? "No bounces or other mail" : "Nothing handled lately"}>
              {tab === "replies" || tab === "all"
                ? "Replies to campaign emails that Smartlead can't tie to a lead show up here within 15 minutes, and in the account managers' sheet."
                : tab === "other" ? "Bounce notices, warm-up and other mail in Smartlead's untracked list show here, kept out of the sheet."
                : `Campaign replies that left Smartlead's untracked list in the last ${handledDays} days show here.`}
            </Empty>
          ) : null}
        </div>
      </div>
    </div>
  );
}
