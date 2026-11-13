"use client";

import { Dialog } from "radix-ui";
import { ArrowLeft, CircleAlert, Search, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { createIcemailOrder } from "@/app/icemail-actions";
import { MAX_PER_DOMAIN, monthlyCost, planMailboxes, readPeople, STYLE_ORDER, styleExample, type AddressStyle } from "@/lib/icemail-board";
import type { FreeInventoryDomain, IcemailAccountInfo, IcemailDomainRow } from "@/lib/icemail-db";
import { int, shortDate } from "@/lib/format";

// Placing new inboxes: the workspace and client, the free domains to put them
// on, the names, and the address styles: each name gets one inbox per style. A review step shows every
// address and what it costs against the wallet before anything is queued.

const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
type Picked = { name: string; source: "icemail" | "inventory" };

export type OrderSeed = { accountId: string; clientId: string | null; replaces: IcemailDomainRow | null; styles: AddressStyle[]; names: string };

export function IcemailOrderDialog({ open, onOpenChange, onPlaced, seed, accounts, domains, freeInventory, clients, dryRun }: {
  open: boolean; onOpenChange: (open: boolean) => void; onPlaced?: () => void; seed: OrderSeed;
  accounts: IcemailAccountInfo[]; domains: IcemailDomainRow[]; freeInventory: FreeInventoryDomain[];
  clients: { id: string; name: string }[]; dryRun: boolean;
}) {
  // The dialog is keyed by the seed, so each opening starts fresh.
  const [accountId, setAccountId] = useState(seed.accountId);
  const [clientId, setClientId] = useState(seed.clientId ?? "");
  const [provider, setProvider] = useState<"GOOGLE" | "MICROSOFT">("GOOGLE");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [search, setSearch] = useState("");
  const [namesText, setNamesText] = useState(seed.names);
  const [styles, setStyles] = useState<AddressStyle[]>(seed.styles);
  const [note, setNote] = useState(seed.replaces ? `Replaces ${seed.replaces.name}` : "");
  const [step, setStep] = useState<"form" | "review">("form");
  const [understood, setUnderstood] = useState(false);
  const [busy, start] = useTransition();

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const price = account ? (provider === "GOOGLE" ? account.priceGoogle : account.priceMicrosoft) : null;
  const q = search.trim().toLowerCase();
  const icemailFree = domains.filter((d) => d.accountId === accountId && d.verdict === "free" && (!q || d.name.includes(q)));
  const inventory = freeInventory.filter((d) => !q || d.name.includes(q));
  const isOn = (name: string) => picked.some((p) => p.name === name);
  const toggle = (p: Picked) => setPicked(isOn(p.name) ? picked.filter((x) => x.name !== p.name) : [...picked, p]);

  const people = useMemo(() => readPeople(namesText), [namesText]);
  const plan = useMemo(() => planMailboxes({ domains: picked.map((p) => p.name), people: people.people, styles }), [picked, people.people, styles]);
  const perDomain = people.people.length * styles.length;
  const sample = people.people[0] ?? { first: "John", last: "Carter" };
  const toggleStyle = (s: AddressStyle) => setStyles(styles.includes(s) ? styles.filter((x) => x !== s) : STYLE_ORDER.filter((x) => x === s || styles.includes(x)));
  const inboxes = "plan" in plan ? plan.plan.reduce((s, p) => s + p.mailboxes.length, 0) : 0;
  const monthly = monthlyCost(inboxes, price);
  const short = monthly != null && account?.walletBalance != null && account.walletBalance < monthly;
  const inventoryPicked = picked.filter((p) => p.source === "inventory");
  const manualNs = inventoryPicked.filter((p) => freeInventory.find((f) => f.name === p.name)?.apiAccess === false);
  const ready = !!account && "plan" in plan;

  const submit = () => start(async () => {
    const r = await createIcemailOrder({
      accountId, clientId: clientId || null, provider, domains: picked, people: people.people, styles,
      note: note || undefined, replaces: seed.replaces?.id ?? null, expectedPrice: price,
    });
    if (!r.ok) { toast.error(r.error); return; }
    const ns = r.data.nameservers ? ` ${plural(r.data.nameservers, "domain")} first ${r.data.nameservers === 1 ? "moves its" : "move their"} nameservers to Icemail.` : "";
    toast.success(`${plural(r.data.inboxes, "inbox", "inboxes")} on ${plural(r.data.domains, "domain")} queued.${ns}${seed.replaces ? ` ${seed.replaces.name} is cancelled to end on its billing date.` : ""}${r.data.dryRun ? " Dry run: Icemail won't be asked." : ""}`);
    onOpenChange(false);
    onPlaced?.();
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog is-wide ice-dialog">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">{seed.replaces ? `Replace ${seed.replaces.name}` : "Place new inboxes"}</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              {seed.replaces
                ? <>Icemail can&apos;t move inboxes, so the same senders are ordered on a free domain, and {seed.replaces.name} is cancelled to stop at its next billing date ({shortDate(seed.replaces.nextBill)}). It keeps sending until then.</>
                : <>Inboxes on free domains: ones already connected to Icemail, or free domains from the inventory, which first move their nameservers to Icemail&apos;s ClouDNS. Icemail sets new inboxes up over a few hours.</>}
            </Dialog.Description>
          </div>

          {step === "form" ? (
            <div className="dialog-body ice-form">
              <div className="ice-grid is-3">
                <label className="field"><span className="field-label">Icemail workspace</span>
                  <select className="select" value={accountId} disabled={!!seed.replaces} onChange={(e) => { setAccountId(e.target.value); setPicked(picked.filter((p) => p.source === "inventory")); }}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.workspaceName ?? a.label}</option>)}
                  </select></label>
                <label className="field"><span className="field-label">Client</span>
                  <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">No client</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select></label>
                <label className="field"><span className="field-label">Inboxes</span>
                  <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as "GOOGLE" | "MICROSOFT")}>
                    <option value="GOOGLE">Google{account?.priceGoogle != null ? ` · ${usd(account.priceGoogle)}/mo` : ""}</option>
                    <option value="MICROSOFT">Microsoft{account?.priceMicrosoft != null ? ` · ${usd(account.priceMicrosoft)}/mo` : ""}</option>
                  </select></label>
              </div>

              <div className="field">
                <span className="field-label">Domains <span className="field-hint">{picked.length ? `${plural(picked.length, "picked")}` : "pick the free domains to put them on"}</span></span>
                <span className="search-input ice-search"><Search size={14} aria-hidden="true" />
                  <input className="input" placeholder="Filter domains" value={search} onChange={(e) => setSearch(e.target.value)} /></span>
                <div className="ice-pick" role="group" aria-label="Free domains">
                  <p className="ice-pick-head">Connected to Icemail, no inboxes <span>{icemailFree.length}</span></p>
                  {icemailFree.length ? icemailFree.map((d) => (
                    <label key={d.id} className={`ice-opt${isOn(d.name) ? " is-on" : ""}`}>
                      <input type="checkbox" className="checkbox" checked={isOn(d.name)} onChange={() => toggle({ name: d.name, source: "icemail" })} />
                      <span className="ice-opt-name">{d.name}</span>
                      <span className="ice-opt-meta">{d.imported === false ? "bought at Icemail" : "connected"}{d.expiresOn && d.imported === false ? ` · renews ${shortDate(d.expiresOn)}` : ""}</span>
                    </label>
                  )) : <p className="ice-pick-none">None{q ? " match" : " in this workspace"}.</p>}
                  <p className="ice-pick-head">Free in the inventory <span>{inventory.length}</span></p>
                  {inventory.length ? inventory.slice(0, 200).map((d) => (
                    <label key={d.id} className={`ice-opt${isOn(d.name) ? " is-on" : ""}`}>
                      <input type="checkbox" className="checkbox" checked={isOn(d.name)} onChange={() => toggle({ name: d.name, source: "inventory" })} />
                      <span className="ice-opt-name">{d.name}</span>
                      <span className="ice-opt-meta">{d.registrar ?? "no registrar"}{d.registrarAccount ? ` · ${d.registrarAccount}` : ""}{d.apiAccess === false ? " · nameservers by hand" : ""}</span>
                    </label>
                  )) : <p className="ice-pick-none">None{q ? " match" : ""}.</p>}
                </div>
              </div>

              <div className="ice-grid is-2">
                <label className="field"><span className="field-label">Names <span className="field-hint">
                  {people.people.length ? `${plural(people.people.length, "name")}, on every domain` : "one person a line: First Last"}
                  {people.bad.length ? `, ${plural(people.bad.length, "line")} without a first and last name` : ""}</span></span>
                  <textarea className="textarea ice-names" value={namesText} onChange={(e) => setNamesText(e.target.value)} spellCheck={false} placeholder={"John Carter"} /></label>
                <div className="ice-col">
                  <div className="field"><span className="field-label">Addresses <span className="field-hint">
                    {perDomain ? `${plural(perDomain, "inbox", "inboxes")} a domain, same full name` : "one inbox a name per style"}{perDomain > MAX_PER_DOMAIN ? `; up to ${MAX_PER_DOMAIN}` : ""}</span></span>
                    <div className="ice-styles" role="group" aria-label="Address styles">
                      {STYLE_ORDER.map((s) => (
                        <label key={s} className={`ice-opt${styles.includes(s) ? " is-on" : ""}`}>
                          <input type="checkbox" className="checkbox" checked={styles.includes(s)} onChange={() => toggleStyle(s)} />
                          <span className="ice-opt-name">{styleExample(s, sample)}@</span>
                        </label>
                      ))}
                    </div></div>
                  <label className="field"><span className="field-label">Note <span className="field-hint">optional</span></span>
                    <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
                </div>
              </div>

              {picked.length && "error" in plan ? <div className="callout tone-warning"><CircleAlert size={16} aria-hidden="true" /><span>{plan.error}</span></div> : null}
              {ready ? (
                <div className={`callout${short ? " tone-warning" : ""}`}>
                  <span>
                    <b>{plural(inboxes, "inbox", "inboxes")}</b> on {plural(picked.length, "domain")}
                    {monthly != null ? <>, <b>{usd(monthly)} a month</b> at {usd(price)} each</> : <>; the price isn&apos;t known until the next Icemail sync</>}
                    {account?.walletBalance != null ? <> against <b>{usd(account.walletBalance)}</b> in the wallet{short ? ": not enough, so Icemail may refuse the order" : ""}</> : null}.
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="dialog-body ice-form">
              <div className="callout">
                <span>
                  <b>{plural(inboxes, "inbox", "inboxes")}</b> for {clients.find((c) => c.id === clientId)?.name ?? "no client"} in {account?.workspaceName ?? account?.label}
                  {monthly != null ? <>: <b>{usd(monthly)} a month</b>, taken from the wallet ({usd(account?.walletBalance ?? null)})</> : null}.
                  {inventoryPicked.length ? <> {plural(inventoryPicked.length, "domain")} from the inventory first {inventoryPicked.length === 1 ? "moves its" : "move their"} nameservers to Icemail&apos;s ClouDNS.</> : null}
                  {seed.replaces ? <> {seed.replaces.name} is cancelled to stop at its next billing date, {shortDate(seed.replaces.nextBill)}.</> : null}
                  {" "}Icemail&apos;s 30-day non-replacement policy applies to the new inboxes, and Icemail makes their passwords.
                </span>
              </div>
              {manualNs.length ? (
                <div className="callout tone-warning"><CircleAlert size={16} aria-hidden="true" />
                  <span>{manualNs.map((p) => p.name).join(", ")}: no API access at the registrar, so the nameservers have to be set by hand. The order waits and says so.</span></div>
              ) : null}
              <div className="ice-review">
                {"plan" in plan ? plan.plan.map((p) => (
                  <div key={p.domain} className="ice-review-domain">
                    <p className="ice-review-name">{p.domain}{picked.find((x) => x.name === p.domain)?.source === "inventory" ? <span className="badge">nameservers first</span> : null}</p>
                    <ul>{p.mailboxes.map((m) => <li key={m.username}><span>{m.username}</span><span className="faint">{m.first_name} {m.last_name}</span></li>)}</ul>
                  </div>
                )) : null}
              </div>
              <label className="ice-confirm">
                <input type="checkbox" className="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                <span>{dryRun ? "Dry run is on: nothing will be sent to Icemail, but treat this as real." : `I understand this spends Icemail credits: about ${usd(monthly)} a month from now on.`}</span>
              </label>
            </div>
          )}

          <div className="dialog-foot">
            {step === "review" ? <button type="button" className="btn" onClick={() => { setStep("form"); setUnderstood(false); }}><ArrowLeft size={14} aria-hidden="true" />Back</button> : null}
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            {step === "form" ? (
              <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setStep("review")}>Review {inboxes ? plural(inboxes, "inbox", "inboxes") : ""}</button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy || !understood} onClick={submit}>
                {busy ? "Queuing…" : `Place ${plural(inboxes, "inbox", "inboxes")}${monthly != null ? ` · ${usd(monthly)}/mo` : ""}${dryRun ? " (dry run)" : ""}`}
              </button>
            )}
          </div>
          <Dialog.Close asChild><button type="button" className="icon-btn pns-x" aria-label="Close"><X size={16} strokeWidth={1.5} /></button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
