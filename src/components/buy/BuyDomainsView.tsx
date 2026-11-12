"use client";

import { Dialog } from "radix-ui";
import { ChevronRight, CircleAlert, Pause, Play, Plus, RotateCcw, ShoppingCart, X } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelPurchaseItem, createPurchaseOrder, loadPurchaseBalances, retryPurchaseItem, setPurchaseOrder } from "@/app/purchase-actions";
import { DomainLink } from "@/components/domains/DomainLink";
import { Badge, Empty } from "@/components/ui";
import { int } from "@/lib/format";
import { planPurchases, workingMinutes } from "@/lib/purchase-schedule";
import type { BuyAccount, PurchaseItemRow, PurchaseOrderRow } from "@/lib/queries";
import type { Tone } from "@/lib/status";

// Buy domains a few at a time: paste the names, pick the registrar accounts,
// set the most to pay and how long to spread it over. Each name then goes
// out on its own, at uneven gaps inside working hours, accounts taking turns.

const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "faint" },
  buying: { label: "Buying…", tone: "info" },
  registering: { label: "Finishing", tone: "info" },
  bought: { label: "Bought", tone: "success" },
  dry_run: { label: "Dry run", tone: "violet" },
  skipped: { label: "Skipped", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "faint" },
};
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hourLabel = (h: number) => (h === 0 || h === 24 ? "12 am" : h === 12 ? "12 pm" : h < 12 ? `${h} am` : `${h - 12} pm`);

function when(d: Date | string, tz: string) {
  const t = new Date(d);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(t);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date());
  return day === today ? `Today ${time}` : `${day} ${time}`;
}

/** One domain a line; also takes commas or spaces. Lines that aren't a domain are reported. */
function readDomains(text: string) {
  const names: string[] = [], bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const found = line.split(/[\s,;]+/)
      .map((w) => w.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.]+$/, ""))
      .filter((w) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(w));
    if (found.length) names.push(...found);
    else if (line.trim()) bad.push(line.trim());
  }
  return { names: [...new Set(names)], bad };
}

type Counts = Record<"waiting" | "bought" | "skipped" | "failed" | "dry" | "cancelled", number>;
function countOf(items: PurchaseItemRow[]): Counts & { spent: number } {
  const c = { waiting: 0, bought: 0, skipped: 0, failed: 0, dry: 0, cancelled: 0, spent: 0 };
  for (const i of items) {
    if (i.status === "bought") { c.bought++; c.spent += i.paidUsd ?? 0; }
    else if (i.status === "skipped") c.skipped++;
    else if (i.status === "failed") c.failed++;
    else if (i.status === "dry_run") c.dry++;
    else if (i.status === "cancelled") c.cancelled++;
    else c.waiting++;
  }
  return c;
}

export function BuyDomainsView({ accounts, orders, timezone, dryRun }: { accounts: BuyAccount[]; orders: PurchaseOrderRow[]; timezone: string; dryRun: boolean }) {
  const names = useMemo(() => new Map(accounts.map((a) => [a.key, `${a.vendor} · ${a.label}`])), [accounts]);
  const all = orders.flatMap((o) => o.items);
  const total = countOf(all);
  const openOrders = orders.filter((o) => !o.cancelledAt && o.items.some((i) => ["queued", "buying", "registering"].includes(i.status)));
  const next = all.filter((i) => i.status === "queued" && openOrders.some((o) => !o.pausedAt && o.items.includes(i))).sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt))[0];

  return (
    <>
      {dryRun ? (
        <div className="callout tone-warning buy-callout" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>Dry run is on for this server (INTEGRATIONS_DRY_RUN), so each domain is checked for price and availability at its time but nothing is bought.</span>
        </div>
      ) : null}

      <section className="stats is-5" aria-label="Purchases">
        <div className="stat"><span className="stat-label">Waiting</span><span className="stat-value">{int(total.waiting)}</span>
          <span className="stat-foot">{next ? `next ${when(next.scheduledAt, timezone)}` : openOrders.length ? "all paused" : "nothing queued"}</span></div>
        <div className="stat"><span className="stat-label">Bought</span><span className="stat-value">{int(total.bought)}</span><span className="stat-foot">{usd(total.spent)} spent</span></div>
        <div className="stat"><span className="stat-label">Skipped</span><span className="stat-value">{int(total.skipped)}</span><span className="stat-foot">taken, premium or over budget</span></div>
        <div className="stat"><span className="stat-label">Failed</span><span className="stat-value">{int(total.failed)}</span><span className="stat-foot">the registrar refused</span></div>
        <div className="stat"><span className="stat-label">Orders running</span><span className="stat-value">{int(openOrders.length)}</span><span className="stat-foot">{plural(orders.length, "order")} in all</span></div>
      </section>

      <div className="table-bar buy-bar">
        <span className="card-sub">Times are in {timezone}. One domain at a time across every order, never closer than the order&apos;s gap.</span>
        <span className="spacer" />
        <NewOrder accounts={accounts} timezone={timezone} dryRun={dryRun} />
      </div>

      {!orders.length ? (
        <Empty icon={ShoppingCart} title="No purchases yet">
          Paste a list of domains, pick the accounts to buy from and how long to spread it over. Each one is bought on its own, at its own time.
        </Empty>
      ) : (
        <div className="buy-orders">{orders.map((o) => <OrderCard key={o.id} order={o} names={names} timezone={timezone} />)}</div>
      )}
    </>
  );
}

function OrderCard({ order, names, timezone }: { order: PurchaseOrderRow; names: Map<string, string>; timezone: string }) {
  const c = countOf(order.items);
  const n = order.items.length;
  const done = n - c.waiting;
  const live = !order.cancelledAt && c.waiting > 0;
  const [open, setOpen] = useState(live);
  const [busy, start] = useTransition();
  const state: { label: string; tone: Tone } = order.cancelledAt ? { label: "Cancelled", tone: "faint" }
    : !c.waiting ? { label: "Done", tone: "success" }
    : order.pausedAt ? { label: "Paused", tone: "warning" } : { label: "Running", tone: "info" };
  const next = order.items.find((i) => i.status === "queued");
  const lastAt = order.items.filter((i) => i.status === "queued").at(-1)?.scheduledAt;
  const act = (what: "pause" | "resume" | "cancel") => start(async () => {
    if (what === "cancel" && !confirm(`Cancel the ${plural(c.waiting, "domain")} still waiting in this order? Bought ones stay bought.`)) return;
    const r = await setPurchaseOrder(order.id, what);
    if (!r.ok) toast.error(r.error);
    else toast.success(what === "pause" ? "Paused" : what === "resume" ? "Resumed, with fresh times from now" : "Cancelled");
  });

  return (
    <section className="card buy-order">
      <div className="card-head">
        <button type="button" className="buy-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronRight size={14} className={open ? "is-open" : ""} aria-hidden="true" />
          <span className="card-title">{plural(n, "domain")}</span>
        </button>
        <Badge tone={state.tone}>{state.label}</Badge>
        {order.note ? <span className="card-sub buy-order-note" title={order.note}>{order.note}</span> : null}
        <span className="spacer" />
        {live ? (order.pausedAt
          ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act("resume")}><Play size={13} aria-hidden="true" />Resume</button>
          : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act("pause")}><Pause size={13} aria-hidden="true" />Pause</button>) : null}
        {live ? <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act("cancel")}>Cancel</button> : null}
      </div>
      <div className="card-body buy-summary">
        <div className="buy-meta">
          Up to {usd(order.maxPriceUsd)} each · over {plural(order.days, "day")}, {hourLabel(order.fromHour)}–{hourLabel(order.toHour)} {order.timezone} · at least {order.minGapMinutes} min apart · ordered {when(order.createdAt, timezone)} by {order.createdBy.split("@")[0]}
        </div>
        <div className="progress" aria-label={`${done} of ${n} done`}><span style={{ width: `${n ? (done / n) * 100 : 0}%` }} /></div>
        <div className="buy-counts">
          <span><b>{int(c.bought)}</b> bought{c.bought ? ` (${usd(c.spent)})` : ""}</span>
          {c.dry ? <span><b>{int(c.dry)}</b> checked in dry run</span> : null}
          {c.skipped ? <span className="buy-warn"><b>{int(c.skipped)}</b> skipped</span> : null}
          {c.failed ? <span className="buy-bad"><b>{int(c.failed)}</b> failed</span> : null}
          {c.cancelled ? <span><b>{int(c.cancelled)}</b> cancelled</span> : null}
          {c.waiting ? <span><b>{int(c.waiting)}</b> waiting{next && !order.pausedAt ? `: next ${when(next.scheduledAt, timezone)}, last ${when(lastAt!, timezone)}` : ""}</span> : null}
        </div>
        {order.pausedAt && order.pausedReason ? (
          <div className="callout tone-warning"><CircleAlert size={16} aria-hidden="true" /><span>{order.pausedReason}</span></div>
        ) : null}
      </div>
      {open ? (
        <div className="buy-scroll">
          <table className="data-table buy-table">
            <thead><tr><th>Time</th><th>Domain</th><th>Account</th><th>Status</th><th className="num">Price</th><th>Note</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {order.items.map((i) => <ItemRow key={i.id} item={i} account={names.get(i.accountKey) ?? (i.accountKey.startsWith("env:") ? "Porkbun · Server .env" : "Removed account")} timezone={timezone} orderOpen={!order.cancelledAt} />)}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function ItemRow({ item, account, timezone, orderOpen }: { item: PurchaseItemRow; account: string; timezone: string; orderOpen: boolean }) {
  const [busy, start] = useTransition();
  const s = STATUS[item.status] ?? { label: item.status, tone: "faint" as Tone };
  const at = item.finishedAt ?? item.startedAt ?? item.scheduledAt;
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => start(async () => {
    const r = await fn();
    if (!r.ok) toast.error(r.error ?? "Didn't work"); else toast.success(ok);
  });
  return (
    <tr>
      <td className="buy-when" title={item.status === "queued" ? "When it's due" : "When it was tried"}>{when(at, timezone)}</td>
      <td className="buy-domain">{item.domainId ? <DomainLink id={item.domainId}>{item.domain}</DomainLink> : item.domain}</td>
      <td className="buy-account" title={account}>{account}</td>
      <td><Badge tone={s.tone}>{s.label}</Badge></td>
      <td className="num">{usd(item.paidUsd ?? item.quotedUsd)}</td>
      <td className="buy-note" title={item.message ?? undefined}>{item.message ? <span>{item.message}</span> : null}</td>
      <td className="buy-act">
        {item.status === "queued" ? (
          <button type="button" className="icon-btn" title="Don't buy this one" aria-label={`Cancel ${item.domain}`} disabled={busy}
            onClick={() => run(() => cancelPurchaseItem(item.id), `${item.domain} won't be bought`)}><X size={14} strokeWidth={1.75} /></button>
        ) : orderOpen && ["failed", "skipped", "cancelled", "dry_run"].includes(item.status) ? (
          <button type="button" className="icon-btn" title="Try again in a few minutes" aria-label={`Retry ${item.domain}`} disabled={busy}
            onClick={() => run(() => retryPurchaseItem(item.id), `${item.domain} is back in the queue`)}><RotateCcw size={14} strokeWidth={1.75} /></button>
        ) : null}
      </td>
    </tr>
  );
}

function NewOrder({ accounts, timezone, dryRun }: { accounts: BuyAccount[]; timezone: string; dryRun: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [maxPrice, setMaxPrice] = useState("15");
  const [days, setDays] = useState(2);
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(21);
  const [gap, setGap] = useState(20);
  const [note, setNote] = useState("");
  const [balances, setBalances] = useState<Record<string, { usd: number | null; error?: string }> | null>(null);
  const [busy, start] = useTransition();
  // When the dialog opened: the preview plans from then.
  const [openedAt, setOpenedAt] = useState(0);

  useEffect(() => {
    if (!open || balances) return;
    loadPurchaseBalances().then(setBalances).catch(() => setBalances({}));
  }, [open, balances]);

  const parsed = useMemo(() => readDomains(text), [text]);
  const price = Number(maxPrice);
  // A preview of the spread; the server draws its own times when it saves.
  const preview = useMemo(() => {
    if (!parsed.names.length || !picked.length) return null;
    const r = planPurchases({ domains: parsed.names, accounts: picked, start: new Date(openedAt + 2 * 60_000), days, fromHour, toHour, timezone, minGapMinutes: gap });
    if ("error" in r) return r;
    const times = r.planned.map((p) => p.at.getTime()).sort((a, b) => a - b);
    const minutes = workingMinutes(new Date(openedAt), days, fromHour, toHour, timezone).length;
    return { first: new Date(times[0]), last: new Date(times.at(-1)!), every: Math.round(minutes / parsed.names.length), perAccount: Math.ceil(parsed.names.length / picked.length) };
  }, [parsed.names, picked, days, fromHour, toHour, timezone, gap, openedAt]);
  const budget = parsed.names.length * (Number.isFinite(price) ? price : 0);
  const pickedBalance = balances ? picked.reduce<number | null>((sum, k) => (sum === null || balances[k]?.usd == null ? null : sum + balances[k].usd!), 0) : null;
  const ready = parsed.names.length > 0 && picked.length > 0 && price > 0 && preview && !("error" in preview);

  const reset = () => { setText(""); setPicked([]); setNote(""); setBalances(null); };
  const submit = () => start(async () => {
    const r = await createPurchaseOrder({ domains: parsed.names, accounts: picked, maxPriceUsd: price, days, fromHour, toHour, minGapMinutes: gap, note: note || undefined });
    if (!r.ok) { toast.error(r.error); return; }
    const skipped = r.data.owned.length ? ` ${plural(r.data.owned.length, "domain")} already in Domain Engine left out.` : "";
    toast.success(`${plural(r.data.scheduled, "domain")} scheduled, first ${when(r.data.first, timezone)}, last ${when(r.data.last, timezone)}.${skipped}${r.data.dryRun ? " Dry run: nothing will be bought." : ""}`);
    setOpen(false);
    reset();
  });

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpenedAt(Date.now()); setOpen(true); }} disabled={!accounts.length}
        title={accounts.length ? "Schedule a list of domains to buy" : "Connect a registrar in Settings → Connections first"}>
        <Plus size={14} strokeWidth={1.75} aria-hidden="true" />Buy domains
      </button>
      <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog is-wide buy-dialog">
            <div className="dialog-head">
              <Dialog.Title className="dialog-title">Buy domains</Dialog.Title>
              <Dialog.Description className="dialog-desc">
                Each domain is bought on its own at a random time inside your hours, accounts taking turns. Just before it pays, it checks the name is still free, not premium and within your price, using the account&apos;s balance only.
              </Dialog.Description>
            </div>
            <div className="dialog-body buy-form">
              <label className="field">
                <span className="field-label">Domains <span className="field-hint">{parsed.names.length ? `${plural(parsed.names.length, "domain")}${parsed.bad.length ? `, ${plural(parsed.bad.length, "line")} not a domain: ${parsed.bad.slice(0, 3).join(", ")}${parsed.bad.length > 3 ? "…" : ""}` : ""}` : "one a line"}</span></span>
                <textarea className="textarea buy-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus placeholder={"brightlanehq.com\nnorthfieldgrowth.com"} />
              </label>

              <div className="field">
                <span className="field-label">Buy from <span className="field-hint">pick one or more; they take turns</span></span>
                <div className="buy-accounts">
                  {accounts.map((a) => {
                    const on = picked.includes(a.key);
                    const b = balances?.[a.key];
                    return (
                      <label key={a.key} className={`buy-account-opt${on ? " is-on" : ""}`}>
                        <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((k) => k !== a.key) : [...picked, a.key])} />
                        <span className="buy-account-name">{a.vendor}<span className="faint"> · {a.label}</span></span>
                        <span className="buy-account-bal" title={b?.error}>
                          {!balances ? "…" : !b || b.error ? "balance unavailable" : b?.usd == null ? (a.provider === "spaceship" ? "balance not shown by Spaceship" : "—") : `${usd(b.usd)} balance`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="buy-grid">
                <label className="field"><span className="field-label">Most to pay, each</span>
                  <span className="buy-money"><span>$</span><input className="input" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} /></span></label>
                <label className="field"><span className="field-label">Spread over</span>
                  <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{plural(d, "day")}</option>)}</select></label>
                <label className="field"><span className="field-label">From</span>
                  <select className="select" value={fromHour} onChange={(e) => setFromHour(Number(e.target.value))}>{HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
                <label className="field"><span className="field-label">Until</span>
                  <select className="select" value={toHour} onChange={(e) => setToHour(Number(e.target.value))}>{HOURS.slice(1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
                <label className="field"><span className="field-label">At least</span>
                  <select className="select" value={gap} onChange={(e) => setGap(Number(e.target.value))}>{[5, 10, 15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min apart</option>)}</select></label>
              </div>

              <label className="field"><span className="field-label">Note <span className="field-hint">optional, e.g. the client</span></span>
                <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>

              {preview ? (
                "error" in preview ? (
                  <div className="callout tone-warning"><CircleAlert size={16} aria-hidden="true" /><span>{preview.error}</span></div>
                ) : (
                  <div className="callout buy-preview">
                    <span>
                      About one every <b>{preview.every} min</b>, from <b>{when(preview.first, timezone)}</b> to <b>{when(preview.last, timezone)}</b> ({timezone})
                      {picked.length > 1 ? <>, about {plural(preview.perAccount, "domain")} per account</> : null}. At most <b>{usd(budget)}</b> in all
                      {pickedBalance !== null ? <> against <b>{usd(pickedBalance)}</b> of balance{pickedBalance < budget ? ": if it runs out, the order pauses and tells you" : ""}</> : null}.
                    </span>
                  </div>
                )
              ) : null}
            </div>
            <div className="dialog-foot">
              <span className="spacer" />
              <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
              <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={submit}>
                {busy ? "Scheduling…" : parsed.names.length ? `Schedule ${plural(parsed.names.length, "purchase")}${dryRun ? " (dry run)" : ""}` : "Schedule"}
              </button>
            </div>
            <Dialog.Close asChild><button type="button" className="icon-btn pns-x" aria-label="Close"><X size={16} strokeWidth={1.5} /></button></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

