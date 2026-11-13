"use client";

import Link from "next/link";
import { Dialog } from "radix-ui";
import { Archive, ArchiveRestore, CircleAlert, Plus, RefreshCw, RotateCcw, Search, Snowflake, Undo2, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { syncIcemailNow } from "@/app/actions";
import { cancelIcemailDomains, cancelIcemailItem, clearIcemailOrders, retryIcemailItem, unclearIcemailOrder, undoIcemailCancel } from "@/app/icemail-actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { Badge, ClientCell, Empty } from "@/components/ui";
import { ago, int, shortDate } from "@/lib/format";
import { DEFAULT_STYLES, itemStage, STYLE_ORDER, VERDICT_META, type IcemailVerdict } from "@/lib/icemail-board";
import type { IcemailBoard, IcemailCancelRow, IcemailDomainRow, IcemailOrderItemRow, IcemailOrderRow } from "@/lib/icemail-db";
import type { Tone } from "@/lib/status";
import { IcemailOrderDialog, type OrderSeed } from "./IcemailOrderDialog";

// One page for Icemail: the wallet, every connected domain with what to do
// about it and when it bills, the free domains, placing new inboxes, and
// cancelling before renewal. Orders and cancels are queued here and sent by
// the worker.

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
/** "Nov 15", with the year only when it isn't this one. */
const md = (d: Date | string) => {
  const t = new Date(d);
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(t.getUTCFullYear() !== new Date().getUTCFullYear() ? { year: "numeric" } : {}) });
};
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
/** A replacement keeps the old domain's count: as many styles as it had inboxes a name. */
const replaceStyles = (d: IcemailDomainRow) =>
  d.people.length ? STYLE_ORDER.slice(0, Math.max(1, Math.min(STYLE_ORDER.length, Math.round(d.mailboxes / d.people.length)))) : DEFAULT_STYLES;
const FILTERS: (IcemailVerdict | "all")[] =["all", "replace", "cancel", "keep", "new", "cancelling", "free"];
const RANK: Record<IcemailVerdict, number> = { replace: 0, cancel: 1, new: 3, keep: 2, cancelling: 4, free: 5 };

const CANCEL_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Sending…", tone: "info" },
  scheduled: { label: "Scheduled", tone: "warning" },
  dry_run: { label: "Dry run", tone: "violet" },
  undo_queued: { label: "Undoing…", tone: "info" },
  undone: { label: "Undone", tone: "faint" },
  failed: { label: "Failed", tone: "danger" },
};

export type IcemailTab = "domains" | "orders" | "cancels";
const LIVE_ITEM = ["queued", "nameservers", "ordering"];
/** Nothing left for the worker to do on it, so it can be cleared. */
const finished = (o: IcemailOrderRow) => !o.items.some((i) => LIVE_ITEM.includes(i.status));

export function IcemailView({ board, dryRun, initialTab = "domains" }: { board: IcemailBoard; dryRun: boolean; initialTab?: IcemailTab }) {
  const { accounts, domains, freeInventory, orders, cancels, clients } = board;
  const [tab, setTabState] = useState<IcemailTab>(initialTab);
  // The open tab goes in the address, so a reload or a shared link opens it.
  const setTab = (t: IcemailTab) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === "domains") url.searchParams.delete("tab"); else url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };
  const openOrders = orders.filter((o) => !o.clearedAt);
  const inFlight = openOrders.filter((o) => !finished(o)).length;
  const [filter, setFilter] = useState<IcemailVerdict | "all">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState<IcemailDomainRow[] | null>(null);
  const [seed, setSeed] = useState<(OrderSeed & { key: number }) | null>(null);
  const [syncing, startSync] = useTransition();

  const counts = useMemo(() => {
    const c = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<IcemailVerdict | "all", number>;
    for (const d of domains) { c[d.verdict]++; c.all++; }
    return c;
  }, [domains]);
  const q = search.trim().toLowerCase();
  const shown = domains
    .filter((d) => (filter === "all" || d.verdict === filter) && (!q || d.name.includes(q) || (d.clientName ?? "").toLowerCase().includes(q)))
    .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || (a.cancelDaysLeft ?? 9999) - (b.cancelDaysLeft ?? 9999) || a.name.localeCompare(b.name));
  const cancellable = (d: IcemailDomainRow) => d.mailboxes > 0 && !d.cancel;
  const selectedRows = domains.filter((d) => selected.includes(d.id));

  const balance = accounts.reduce<number | null>((s, a) => (a.walletBalance == null ? s : (s ?? 0) + a.walletBalance), null);
  const monthly = accounts.reduce((s, a) => s + a.monthly, 0);
  const mailboxes = accounts.reduce((s, a) => s + a.mailboxes, 0);
  const renewing = accounts.reduce((s, a) => s + a.renewing, 0), renewingCost = accounts.reduce((s, a) => s + a.renewingCost, 0);
  const toGo = domains.filter((d) => d.verdict === "replace" || d.verdict === "cancel");
  const soonest = toGo.filter((d) => d.cancelBy).sort((a, b) => (a.cancelDaysLeft ?? 0) - (b.cancelDaysLeft ?? 0))[0];
  const goSaves = toGo.reduce((s, d) => s + (d.monthly ?? 0), 0);
  const priceGoogle = accounts.find((a) => a.priceGoogle != null)?.priceGoogle ?? null;

  const openOrder = (replaces: IcemailDomainRow | null = null) => setSeed({
    key: Date.now(),
    accountId: replaces?.accountId ?? accounts[0].id,
    clientId: replaces?.clientId ?? null,
    replaces,
    styles: replaces ? replaceStyles(replaces) : DEFAULT_STYLES,
    names: replaces ? replaces.people.map((p) => `${p.first} ${p.last}`).join("\n") : "",
  });
  const syncAll = () => startSync(async () => {
    for (const a of accounts) {
      const r = await syncIcemailNow(a.id);
      if (!r.ok) toast.error(`${a.label}: ${r.error}`); else toast.success(`${a.label}: ${r.data.message}`);
    }
  });

  if (!accounts.length) {
    return (
      <Empty icon={Snowflake} title="No Icemail workspace connected" action={<Link className="btn btn-sm" href="/settings">Open Settings</Link>}>
        Add a workspace&apos;s API key under Settings → Connections. Ordering and cancelling need a key with the Editor role or higher.
      </Empty>
    );
  }

  return (
    <>
      {dryRun ? (
        <div className="callout tone-warning ice-callout" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>Dry run is on for this server (INTEGRATIONS_DRY_RUN): orders and cancels are queued and checked, but Icemail is never asked.</span>
        </div>
      ) : null}

      <section className="stats is-5" aria-label="Icemail">
        <div className="stat"><span className="stat-label">Wallet</span><span className="stat-value">{usd(balance)}</span>
          <span className="stat-foot" title={accounts.map((a) => `${a.workspaceName ?? a.label}: ${usd(a.walletBalance)}`).join("\n")}>
            {accounts.length > 1 ? `${accounts.length} workspaces` : accounts[0].autoTopup ? "auto top-up on" : accounts[0].autoTopup === false ? "auto top-up off" : "credits"}</span></div>
        <div className="stat"><span className="stat-label">Inboxes</span><span className="stat-value">{int(mailboxes)}</span>
          <span className="stat-foot">{usd(monthly)} a month{priceGoogle != null ? ` · ${usd(priceGoogle)} each` : ""}</span></div>
        <div className="stat"><span className="stat-label">Renewing in 7 days</span><span className="stat-value">{int(renewing)}</span>
          <span className="stat-foot">{renewing ? `${usd(renewingCost)} due` : "nothing due"}</span></div>
        <div className="stat"><span className="stat-label">To replace or cancel</span><span className="stat-value">{int(toGo.length)}</span>
          <span className="stat-foot">{soonest ? `first by ${shortDate(soonest.cancelBy)} · saves ${usd(goSaves)}/mo` : "nothing to act on"}</span></div>
        <div className="stat"><span className="stat-label">Free domains</span><span className="stat-value">{int(counts.free + freeInventory.length)}</span>
          <span className="stat-foot">{int(counts.free)} on Icemail · {int(freeInventory.length)} in the inventory</span></div>
      </section>

      <div className="ice-tabs">
        <span className="section-tabs" role="tablist" aria-label="Icemail">
          <button type="button" role="tab" aria-selected={tab === "domains"} onClick={() => setTab("domains")}>Domains <span>{int(domains.length)}</span></button>
          <button type="button" role="tab" aria-selected={tab === "orders"} onClick={() => setTab("orders")}
            title={inFlight ? `${plural(inFlight, "order")} still going to Icemail` : undefined}>
            Orders <span>{int(openOrders.length)}</span>{inFlight ? <i className="ice-dot" aria-label="in progress" /> : null}</button>
          <button type="button" role="tab" aria-selected={tab === "cancels"} onClick={() => setTab("cancels")}>Cancels <span>{int(cancels.length)}</span></button>
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => openOrder()}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />Place new inboxes</button>
      </div>

      {tab === "domains" ? (<>
      <div className="table-bar ice-bar">
        <span className="view-tabs" role="tablist" aria-label="Verdict">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "is-on" : undefined} onClick={() => setFilter(f)}
              title={f === "all" ? undefined : VERDICT_META[f].hint}>
              {f === "all" ? "All" : VERDICT_META[f].label} <span>{int(counts[f])}</span>
            </button>
          ))}
        </span>
        <span className="search-input"><Search size={14} aria-hidden="true" />
          <input className="input" placeholder="Domain or client" value={search} onChange={(e) => setSearch(e.target.value)} /></span>
        <span className="spacer" />
        <span className="card-sub" title="Domains, inboxes, wallet and prices come from the Icemail sync, every 30 minutes">
          {board.syncedAt ? `Synced ${ago(board.syncedAt)}` : "Not synced yet"}</span>
        <button type="button" className="btn btn-sm" onClick={syncAll} disabled={syncing}><RefreshCw size={14} strokeWidth={1.75} className={syncing ? "dx-spin" : undefined} aria-hidden="true" />Sync</button>
        {selected.length ? (
          <button type="button" className="btn btn-sm" onClick={() => setCancelling(selectedRows.filter(cancellable))}>Cancel {plural(selectedRows.filter(cancellable).length, "domain")}</button>
        ) : null}
      </div>

      {shown.length ? (
        <div className="table-wrap ice-wrap">
          <table className="data-table ice-table">
            <thead>
              <tr>
                <th className="ice-check"><input type="checkbox" className="checkbox" aria-label="Select all shown"
                  checked={shown.some(cancellable) && shown.filter(cancellable).every((d) => selected.includes(d.id))}
                  onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...shown.filter(cancellable).map((d) => d.id)])] : selected.filter((id) => !shown.some((d) => d.id === id)))} /></th>
                <th>Domain</th>
                <th>Client</th>
                <th>Verdict</th>
                <th className="is-num">Inboxes</th>
                <th className="is-num">A month</th>
                <th>Next bill</th>
                <th>Cancel by</th>
                <th className="is-num" title="Sent, replies and bounces over the last 7 days">7 days</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <DomainRow key={d.id} d={d} selected={selected.includes(d.id)} canSelect={cancellable(d)}
                  onSelect={(on) => setSelected(on ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
                  onCancel={() => setCancelling([d])} onReplace={() => openOrder(d)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={Snowflake} title={domains.length ? "Nothing here" : "No Icemail domains yet"}>
          {domains.length ? "No domain matches this filter." : "Once the sync has run, every domain connected to Icemail shows here with what to do about it."}
        </Empty>
      )}

      </>) : tab === "orders" ? <OrdersSection orders={orders} /> : <CancelsSection cancels={cancels} />}

      {seed ? (
        <IcemailOrderDialog key={seed.key} open onOpenChange={(o) => { if (!o) setSeed(null); }} onPlaced={() => setTab("orders")} seed={seed}
          accounts={accounts} domains={domains} freeInventory={freeInventory} clients={clients} dryRun={dryRun} />
      ) : null}
      {cancelling ? <CancelDialog rows={cancelling} dryRun={dryRun} onClose={(done) => { setCancelling(null); if (done) setSelected([]); }} /> : null}
    </>
  );
}

function DomainRow({ d, selected, canSelect, onSelect, onCancel, onReplace }: {
  d: IcemailDomainRow; selected: boolean; canSelect: boolean; onSelect: (on: boolean) => void; onCancel: () => void; onReplace: () => void;
}) {
  const m = VERDICT_META[d.verdict];
  const [busy, start] = useTransition();
  const undo = () => start(async () => {
    if (!d.cancel) return;
    const r = await undoIcemailCancel(d.cancel.id);
    if (!r.ok) toast.error(r.error); else toast.success(r.data.sent ? "Asking Icemail to keep its inboxes" : "Cancel taken back");
  });
  const late = d.cancelDaysLeft != null && d.cancelDaysLeft <= 3 && (d.verdict === "replace" || d.verdict === "cancel");
  return (
    <tr data-selected={selected || undefined}>
      <td className="ice-check">{canSelect ? <input type="checkbox" className="checkbox" aria-label={`Select ${d.name}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} /> : null}</td>
      <td className="ice-domain">{d.domainId ? <DomainLink id={d.domainId}>{d.name}</DomainLink> : d.name}</td>
      <td><ClientCell name={d.clientName} hue={d.clientHue} /></td>
      <td><span className="ice-verdict">
        <Badge tone={m.tone}>{m.label}</Badge>
        {d.cancel ? <span className="ice-why">{d.cancel.status === "scheduled" ? `Icemail deletes its inboxes ${shortDate(d.cancel.deletesOn ?? d.nextBill)}` : d.cancel.status === "undo_queued" ? "Taking the cancel back" : "Cancel being sent"}{d.cancel.reason === "replace" ? " · replaced" : ""}</span>
          : d.reasons.length ? <span className="ice-why" title={d.reasons.join("\n")}>{d.reasons[0]}</span> : null}
      </span></td>
      <td className="is-num">{d.mailboxes ? int(d.mailboxes) : <span className="zero">0</span>}</td>
      <td className="is-num">{usd(d.monthly)}</td>
      <td title={d.nextBill ? `Its inboxes bill next on ${shortDate(d.nextBill)}` : undefined}>{d.nextBill ? md(d.nextBill) : <span className="zero">—</span>}</td>
      <td className={late ? "ice-late" : undefined} title={d.cancelBy ? `Two days before it bills. ${d.cancelDaysLeft! < 0 ? "Too late to stop this bill: a cancel now stops the one after" : `${plural(d.cancelDaysLeft!, "day")} left`}` : undefined}>
        {d.cancelBy && d.mailboxes && !d.cancel ? <>{md(d.cancelBy)}<span className="ice-days">{d.cancelDaysLeft! < 0 ? "passed" : d.cancelDaysLeft === 0 ? "today" : `${d.cancelDaysLeft}d`}</span></> : <span className="zero">—</span>}
      </td>
      <td className="is-num ice-nums" title={`${int(d.sent7)} sent, ${int(d.replies7)} replies, ${int(d.bounces7)} bounces · ${plural(d.connected, "inbox", "inboxes")} connected in Smartlead`}>
        {d.sent7 ? <>{int(d.sent7)}<span> · {int(d.replies7)} · {int(d.bounces7)}</span></> : <span className="zero">—</span>}
      </td>
      <td className="ice-act">
        {d.cancel && (d.cancel.status === "queued" || d.cancel.status === "scheduled") ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={undo} title="Keep its inboxes after all"><Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />Undo</button>
        ) : d.mailboxes && !d.cancel ? (
          <>
            {d.verdict === "replace" || d.verdict === "keep" ? <button type="button" className="btn btn-sm" onClick={onReplace} title="Order the same senders on a free domain and cancel this one before it renews">Replace</button> : null}
            <button type="button" className="btn btn-sm" onClick={onCancel} title="Delete its inboxes at their next billing date">Cancel</button>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function CancelDialog({ rows, dryRun, onClose }: { rows: IcemailDomainRow[]; dryRun: boolean; onClose: (done: boolean) => void }) {
  const [understood, setUnderstood] = useState(false);
  const [busy, start] = useTransition();
  const inboxes = rows.reduce((s, d) => s + d.mailboxes, 0);
  const saves = rows.reduce((s, d) => s + (d.monthly ?? 0), 0);
  const submit = () => start(async () => {
    const r = await cancelIcemailDomains({ ids: rows.map((d) => d.id) });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${plural(r.data.queued, "domain")} cancelled to stop at the next billing date.${r.data.dryRun ? " Dry run: Icemail won't be asked." : ""}`);
    onClose(true);
  });
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog ice-dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Cancel {rows.length === 1 ? rows[0].name : plural(rows.length, "domain")}</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              Icemail deletes every inbox on {rows.length === 1 ? "it" : "them"} on {rows.length === 1 ? "its" : "each one's"} next billing date, so nothing renews. They keep sending until then. You can undo it here until that date; after it, the inboxes and their mail are gone for good.
            </Dialog.Description>
          </div>
          <div className="dialog-body ice-form">
            {!rows.length ? <p className="card-sub">None of the selected domains has live inboxes to cancel.</p> : (
              <ul className="ice-cancel-list">
                {rows.map((d) => (
                  <li key={d.id}><span className="ice-opt-name">{d.name}</span>
                    <span className="faint">{plural(d.mailboxes, "inbox", "inboxes")} · {usd(d.monthly)}/mo · deleted {d.nextBill ? shortDate(d.nextBill) : "at the next bill"}</span></li>
                ))}
              </ul>
            )}
            <label className="ice-confirm">
              <input type="checkbox" className="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>{dryRun ? "Dry run is on: Icemail won't be asked, but treat this as real." : `Delete ${plural(inboxes, "inbox", "inboxes")} at their billing date, saving ${usd(saves)} a month.`}</span>
            </label>
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Keep them</button></Dialog.Close>
            <button type="button" className="btn btn-danger" disabled={busy || !understood || !rows.length} onClick={submit}>
              {busy ? "Queuing…" : `Cancel ${plural(rows.length, "domain")}${dryRun ? " (dry run)" : ""}`}
            </button>
          </div>
          <Dialog.Close asChild><button type="button" className="icon-btn pns-x" aria-label="Close"><X size={16} strokeWidth={1.5} /></button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OrdersSection({ orders }: { orders: IcemailOrderRow[] }) {
  const [showCleared, setShowCleared] = useState(false);
  const [busy, start] = useTransition();
  const open = orders.filter((o) => !o.clearedAt);
  const cleared = orders.filter((o) => o.clearedAt);
  const done = open.filter(finished);
  const going = open.length - done.length;
  const shown = showCleared ? orders : open;
  const clear = (ids: string[]) => start(async () => {
    const r = await clearIcemailOrders(ids);
    if (!r.ok) toast.error(r.error); else toast.success(`${plural(r.data.cleared, "order")} cleared`);
  });
  const bringBack = (id: string) => start(async () => {
    const r = await unclearIcemailOrder(id);
    if (!r.ok) toast.error(r.error); else toast.success("Back in the list");
  });

  return (
    <section className="ice-section" aria-label="Orders">
      <div className="table-bar ice-bar">
        <span className="card-sub">{open.length ? `${plural(open.length, "order")}${going ? `, ${going} still going to Icemail` : ""}` : "No open orders"}</span>
        <span className="spacer" />
        {cleared.length ? (
          <label className="ice-toggle"><input type="checkbox" className="checkbox" checked={showCleared} onChange={(e) => setShowCleared(e.target.checked)} />Show cleared <span>{int(cleared.length)}</span></label>
        ) : null}
        {done.length ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => clear(done.map((o) => o.id))}
            title="Hide every order with nothing left to send. Nothing is deleted, and Icemail isn't asked">
            <Archive size={14} strokeWidth={1.75} aria-hidden="true" />Clear finished <span className="faint">{int(done.length)}</span></button>
        ) : null}
      </div>
      {shown.length ? (
        <div className="ice-orders">
          {shown.map((o) => {
            const inboxes = o.items.reduce((s, i) => s + i.mailboxes, 0);
            return (
              <section key={o.id} className={`card${o.clearedAt ? " is-cleared" : ""}`}>
                <div className="card-head ice-order-head">
                  <span className="card-title">{plural(inboxes, "inbox", "inboxes")} on {plural(o.items.length, "domain")}</span>
                  <ClientCell name={o.clientName} hue={o.clientHue} />
                  <span className="card-sub">{o.accountLabel} · {o.provider === "GOOGLE" ? "Google" : "Microsoft"}{o.quotedMonthlyUsd != null ? ` · ${usd(o.quotedMonthlyUsd)}/mo` : ""} · {o.createdBy.split("@")[0]}, {ago(o.createdAt)}</span>
                  {o.note ? <span className="card-sub ice-note" title={o.note}>{o.note}</span> : null}
                  <span className="spacer" />
                  {o.clearedAt ? (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => bringBack(o.id)} title={`Cleared by ${(o.clearedBy ?? "").split("@")[0]}, ${ago(o.clearedAt)}`}>
                      <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />Bring back</button>
                  ) : finished(o) ? (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => clear([o.id])} title="Hide it from this list. Nothing is deleted, and Icemail isn't asked">
                      <Archive size={14} strokeWidth={1.75} aria-hidden="true" />Clear</button>
                  ) : <Badge tone="info">In progress</Badge>}
                </div>
                <table className="data-table ice-items">
                  <tbody>{o.items.map((i) => <OrderItem key={i.id} item={i} />)}</tbody>
                </table>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty icon={Snowflake} title={orders.length ? "Every order is cleared" : "No orders yet"}>
          {orders.length ? "Tick Show cleared to see them again." : "Orders placed with Place new inboxes show here, from the queue until their inboxes are connected in Smartlead."}
        </Empty>
      )}
    </section>
  );
}

function OrderItem({ item }: { item: IcemailOrderItemRow }) {
  const s = itemStage(item);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => start(async () => {
    const r = await fn();
    if (!r.ok) toast.error(r.error ?? "Didn't work"); else toast.success(ok);
  });
  return (
    <tr>
      <td className="ice-domain">{item.domainId ? <DomainLink id={item.domainId}>{item.domainName}</DomainLink> : item.domainName}</td>
      <td><Badge tone={s.tone}>{s.label}</Badge></td>
      <td className="ice-users" title={item.usernames.join("\n")}>{item.usernames.map((u) => u.split("@")[0]).join(", ")}</td>
      <td className="ice-msg" title={s.text ?? undefined}>{s.text}</td>
      <td className="ice-act">
        {item.status === "queued" || item.status === "nameservers" ? (
          <button type="button" className="icon-btn" title="Take it out of the order" aria-label={`Take ${item.domainName} out`} disabled={busy}
            onClick={() => run(() => cancelIcemailItem(item.id), `${item.domainName} taken out`)}><X size={14} strokeWidth={1.75} /></button>
        ) : ["failed", "dry_run", "cancelled"].includes(item.status) ? (
          <button type="button" className="icon-btn" title="Try again" aria-label={`Retry ${item.domainName}`} disabled={busy}
            onClick={() => run(() => retryIcemailItem(item.id), `${item.domainName} is back in the queue`)}><RotateCcw size={14} strokeWidth={1.75} /></button>
        ) : null}
      </td>
    </tr>
  );
}

function CancelsSection({ cancels }: { cancels: IcemailCancelRow[] }) {
  if (!cancels.length) {
    return <Empty icon={Snowflake} title="No cancels in the last 60 days">Cancel or Replace on a domain asks Icemail to delete its inboxes on their next billing date; each shows here.</Empty>;
  }
  return (
    <section className="ice-section" aria-label="Cancels">
      <div className="table-wrap">
        <table className="data-table ice-items">
          <thead><tr><th>Domain</th><th>Status</th><th>Inboxes</th><th>Deleted on</th><th>Why</th><th>Asked</th></tr></thead>
          <tbody>
            {cancels.map((k) => {
              const s = CANCEL_STATUS[k.status] ?? { label: k.status, tone: "faint" as Tone };
              return (
                <tr key={k.id}>
                  <td className="ice-domain">{k.domainId ? <DomainLink id={k.domainId}>{k.domainName}</DomainLink> : k.domainName}</td>
                  <td><Badge tone={s.tone}>{s.label}</Badge></td>
                  <td>{k.mailboxes ?? "—"}</td>
                  <td>{k.deletesOn ? shortDate(k.deletesOn) : "—"}</td>
                  <td className="ice-msg" title={k.message ?? undefined}>{k.message ?? (k.reason === "replace" ? "Replaced by a new order" : "Cancelled")}</td>
                  <td className="card-sub">{k.createdBy.split("@")[0]}, {ago(k.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
