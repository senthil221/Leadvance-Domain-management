"use client";

import { Dialog } from "radix-ui";
import { Info, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { createSmartleadTag, loadSmartleadTags, updateInboxSettings, updateInboxTags, updateWarmupConfig } from "@/app/actions";
import { int } from "@/lib/format";

type LimitMode = "set" | "random" | "split";
type Current = { dailyLimit: number | null; minWait: number | null; warmupMin: number | null; warmupPerDay: number | null; warmupRampup: number | null; warmupReplyRate: number | null };
type Tag = { id: number; name: string; color: string };
type Result = { ok: true; data: unknown } | { ok: false; error: string };

const r = (x: number | null, fallback: number) => String(x == null ? fallback : Math.round(x));
const n = (s: string) => Math.max(0, Math.round(Number(s)));
const blank = (...v: string[]) => v.some((s) => s.trim() === "");
const splitTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

function Num({ id, label, v, set, max, disabled }: { id: string; label: string; v: string; set: (s: string) => void; max?: number; disabled?: boolean }) {
  return (
    <label className="field" htmlFor={id}>
      <span className="cfg-label">{label}</span>
      <input id={id} className="input num" inputMode="numeric" type="number" min={0} max={max} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />
    </label>
  );
}

function Check({ label, checked, set }: { label: string; checked: boolean; set: (b: boolean) => void }) {
  return (
    <label className="cfg-check">
      <span>{label}</span>
      <input type="checkbox" className="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
    </label>
  );
}

function Card({ title, children, foot }: { title: string; children: ReactNode; foot: ReactNode }) {
  return (
    <section className="cfg-card">
      <div className="cfg-head">{title}</div>
      <div className="cfg-body">{children}</div>
      <div className="cfg-foot">{foot}</div>
    </section>
  );
}

// Smartlead's "Configure settings", for the selected inboxes: tags, outbound
// (daily limit and gap between emails) and warmup, each applied on its own.
export function InboxSettingsDialog({ open, onOpenChange, inboxIds, domains, current, selectedTags, knownTags, dryRun, appProblem }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inboxIds: string[];
  domains: number;
  current: Current;
  /** Tags every selected inbox already has. */
  selectedTags: string[];
  /** Tag names seen on inboxes, shown when the workspace list can't be loaded. */
  knownTags: string[];
  dryRun: boolean;
  /** Why the Smartlead token can't be used, or null when it can. */
  appProblem: string | null;
}) {
  const count = inboxIds.length;
  const [tags, setTags] = useState("");
  const [newTag, setNewTag] = useState("");
  const [workspaceTags, setWorkspaceTags] = useState<Tag[] | null>(null);
  const [mode, setMode] = useState<LimitMode>("set");
  const [max, setMax] = useState("");
  const [wait, setWait] = useState("");
  const [keepMax, setKeepMax] = useState(false);
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [total, setTotal] = useState("");
  const [wMin, setWMin] = useState("");
  const [wMax, setWMax] = useState("");
  const [rampup, setRampup] = useState("");
  const [reply, setReply] = useState("");
  const [wTag, setWTag] = useState("hey-there");
  const [rampOn, setRampOn] = useState(false);
  const [error, setError] = useState<{ card: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  // Fill the fields from the selection each time the dialog opens.
  const key = open ? inboxIds.join(",") : null;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    if (key !== null) {
      setTags(selectedTags.join(", ")); setNewTag("");
      setMode("set"); setMax(r(current.dailyLimit, 15)); setWait(r(current.minWait, 15)); setKeepMax(false);
      setLo(""); setHi(""); setTotal(current.dailyLimit != null ? String(Math.round(current.dailyLimit * count)) : "");
      setWMin(r(current.warmupMin, 4)); setWMax(r(current.warmupPerDay, 9)); setRampup(r(current.warmupRampup, 1)); setReply(r(current.warmupReplyRate, 60));
      setRampOn(false); setError(null);
    }
  }

  useEffect(() => {
    if (open && !appProblem && workspaceTags === null) loadSmartleadTags().then((res) => setWorkspaceTags(res.ok ? res.data.tags : []));
  }, [open, appProblem, workspaceTags]);

  const run = (card: string, fn: () => Promise<Result>, message: (data: never) => string) => {
    setError(null);
    setBusy(card);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) return void setError({ card, text: res.error });
      toast.success(message(res.data as never));
    });
  };
  const fail = (card: string, text: string) => setError({ card, text });
  const err = (card: string) => (error?.card === card ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error.text}</span></div> : null);
  const queued = (data: { queued: number; total: number | null }) =>
    `${dryRun ? "Dry run: " : ""}Updating ${data.queued} inbox${data.queued === 1 ? "" : "es"}${data.total != null ? ` · ${int(data.total)} a day in total` : ""}`;

  const chosen = new Set(splitTags(tags).map((t) => t.toLowerCase()));
  const chips: Tag[] = workspaceTags ?? knownTags.map((name, i) => ({ id: -i - 1, name, color: "" }));
  const toggleTag = (name: string) => {
    const list = splitTags(tags);
    setTags((chosen.has(name.toLowerCase()) ? list.filter((t) => t.toLowerCase() !== name.toLowerCase()) : [...list, name]).join(", "));
  };

  const applyTags = () => {
    const list = splitTags(tags);
    if (!list.length) return fail("tags", "Enter at least one tag");
    run("tags", () => updateInboxTags({ inboxIds, tags: list }), (d: { message: string }) => d.message);
  };
  const create = () => {
    const name = newTag.trim();
    if (!name) return fail("tags", "Give the tag a name");
    run("create", async () => {
      const res = await createSmartleadTag(name);
      if (res.ok) {
        setNewTag("");
        if (res.data.tag) setWorkspaceTags((w) => [...(w ?? []), res.data.tag!]);
      }
      return res;
    }, (d: { message: string }) => d.message);
  };

  const applyOutbound = () => {
    if (blank(wait)) return fail("outbound", "Enter the minimum wait");
    if (mode === "set" && !keepMax && blank(max)) return fail("outbound", "Enter the max emails per day");
    if (mode !== "set" && blank(lo, hi)) return fail("outbound", "Enter the lowest and highest per inbox");
    if (mode === "split" && blank(total)) return fail("outbound", "Enter the total per day");
    const dailyLimit =
      mode === "set" ? (keepMax ? { mode: "keep" as const } : { mode, value: n(max) })
      : mode === "random" ? { mode, min: n(lo), max: n(hi) }
      : { mode, total: n(total), min: n(lo), max: n(hi) };
    run("outbound", () => updateInboxSettings({ inboxIds, dailyLimit, minWait: n(wait) }), queued);
  };

  const applyWarmup = () => {
    if (blank(wMin, wMax, rampup, reply)) return fail("warmup", "Fill in every warmup field");
    run("warmup", () => updateWarmupConfig({ inboxIds, min: n(wMin), max: n(wMax), rampup: n(rampup), replyRate: n(reply), tag: wTag, rampupEnabled: rampOn }),
      (d: { message: string }) => d.message);
  };
  const toggleWarmup = (on: boolean) =>
    run(on ? "warm-on" : "warm-off", () => updateInboxSettings({ inboxIds, dailyLimit: { mode: "keep" }, warmupEnabled: on }), queued);

  const loN = Number(lo), hiN = Number(hi), totalN = Number(total);
  const splitHint = mode === "split" && lo && hi && total
    ? totalN < count * loN ? `Too low: ${count} inboxes at ${loN} each already make ${int(count * loN)}. It will be raised to that.`
      : totalN > count * hiN ? `Too high: ${count} inboxes at ${hiN} each carry at most ${int(count * hiN)}. It will be capped there.`
      : `About ${(totalN / count).toFixed(1)} per inbox, each between ${loN} and ${hiN}.`
    : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog is-xl">
          <div className="dialog-head cfg-top">
            <div>
              <Dialog.Title className="dialog-title">Configure settings</Dialog.Title>
              <Dialog.Description className="dialog-desc">
                {int(count)} inbox{count === 1 ? "" : "es"} on {domains} domain{domains === 1 ? "" : "s"}. Each card is applied on its own.
                {dryRun ? " Dry run is on: nothing is written to Smartlead." : ""}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" className="btn btn-sm btn-icon" aria-label="Close"><X size={15} /></button></Dialog.Close>
          </div>
          <div className="dialog-body">
            <div className="cfg-grid">
              <Card title="Tag management" foot={<button type="button" className="btn btn-primary cfg-apply" disabled={Boolean(appProblem) || busy !== null} onClick={applyTags}>{busy === "tags" ? "Updating…" : "Update tags"}</button>}>
                <label className="field" htmlFor="cfg-tags">
                  <span className="cfg-label">Tags</span>
                  <input id="cfg-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="warmup, client-name" />
                </label>
                <div className="field">
                  <span className="cfg-label">Create a tag</span>
                  <div className="flex gap-2">
                    <input className="input flex-1" value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag name" aria-label="New tag name"
                      onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
                    <button type="button" className="btn" disabled={Boolean(appProblem) || busy !== null} onClick={create}>{busy === "create" ? "…" : "Create"}</button>
                  </div>
                  <span className="field-hint">A colour is picked automatically.</span>
                </div>
                <div className="field">
                  <span className="cfg-label flex justify-between"><span>Workspace tags</span><span>{chips.length || ""}</span></span>
                  <div className="cfg-chips">
                    {chips.length ? chips.map((t) => (
                      <button key={t.id} type="button" className="cfg-chip" aria-pressed={chosen.has(t.name.toLowerCase())} onClick={() => toggleTag(t.name)} title={t.name}>
                        <i style={t.color ? { background: t.color } : undefined} />{t.name}
                      </button>
                    )) : <span className="field-hint">{workspaceTags === null && !appProblem ? "Loading…" : "No tags yet"}</span>}
                  </div>
                  <span className="field-hint">Click a tag to add or remove it. Updating replaces each inbox&apos;s tags.</span>
                </div>
                {appProblem ? <p className="cfg-note is-warn">{appProblem.replace("Reconnecting", "Tags")}</p> : null}
                {err("tags")}
              </Card>

              <Card title="Outbound settings" foot={<button type="button" className="btn btn-primary cfg-apply" disabled={busy !== null} onClick={applyOutbound}>{busy === "outbound" ? "Updating…" : "Update outbound settings"}</button>}>
                <div className="seg cfg-seg" role="group" aria-label="Daily limit">
                  {([["set", "Same for all"], ["random", "Random"], ["split", "Split a total"]] as const).map(([k, label]) => (
                    <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>{label}</button>
                  ))}
                </div>
                {mode === "set" ? (
                  <div className="cfg-two">
                    <Num id="cfg-max" label="Max emails / day" v={max} set={setMax} max={1000} disabled={keepMax} />
                    <Num id="cfg-wait" label="Min wait (minutes)" v={wait} set={setWait} max={1440} />
                  </div>
                ) : (
                  <>
                    <div className="cfg-two">
                      <Num id="cfg-lo" label="Lowest / inbox" v={lo} set={setLo} max={1000} />
                      <Num id="cfg-hi" label="Highest / inbox" v={hi} set={setHi} max={1000} />
                    </div>
                    <div className="cfg-two">
                      {mode === "split" ? <Num id="cfg-total" label="Total / day, all inboxes" v={total} set={setTotal} /> : null}
                      <Num id="cfg-wait" label="Min wait (minutes)" v={wait} set={setWait} max={1440} />
                    </div>
                  </>
                )}
                {mode === "set" ? <Check label="Keep each inbox's current max" checked={keepMax} set={setKeepMax} /> : null}
                {splitHint ? <p className="cfg-note">{splitHint}</p> : null}
                <p className="cfg-note">
                  {mode === "random" ? "Each inbox gets its own number between the two, once. For a new mix every day, use a daily plan. "
                    : mode === "split" ? "The total is shared out at random, inside the per-inbox range. " : ""}
                  Smartlead saves both outbound values together, so the min wait is written to <b>every</b> selected inbox.
                </p>
                {err("outbound")}
              </Card>

              <Card title="Warmup settings" foot={<button type="button" className="btn btn-primary cfg-apply" disabled={busy !== null} onClick={applyWarmup}>{busy === "warmup" ? "Updating…" : "Update warmup settings"}</button>}>
                <div className="cfg-two">
                  <Num id="cfg-wmin" label="Min warmup / day" v={wMin} set={setWMin} max={1000} />
                  <Num id="cfg-wmax" label="Max warmup / day" v={wMax} set={setWMax} max={1000} />
                </div>
                <div className="cfg-two">
                  <Num id="cfg-ramp" label="Ramp-up value" v={rampup} set={setRampup} max={1000} />
                  <Num id="cfg-reply" label="Reply rate %" v={reply} set={setReply} max={100} />
                </div>
                <label className="field" htmlFor="cfg-wtag">
                  <span className="cfg-label">Warmup tag identifier</span>
                  <input id="cfg-wtag" className="input" value={wTag} onChange={(e) => setWTag(e.target.value)} />
                </label>
                <p className="cfg-note">Smartlead picks a random warmup count between Min and Max each day. Its own default floor is 4, so raising Min keeps warmup close to campaign volume on quiet days.</p>
                <Check label="Enable ramp-up" checked={rampOn} set={setRampOn} />
                <div className="cfg-two">
                  <button type="button" className="btn cfg-on" disabled={busy !== null} onClick={() => toggleWarmup(true)}>{busy === "warm-on" ? "…" : "Enable warmup"}</button>
                  <button type="button" className="btn cfg-off" disabled={busy !== null} onClick={() => toggleWarmup(false)}>{busy === "warm-off" ? "…" : "Disable warmup"}</button>
                </div>
                <p className="cfg-note">Enable and Disable only switch warmup on or off; each inbox keeps its own values. The fields above are written by <b>Update warmup settings</b>{appProblem ? ". Without a Smartlead token, Min and the warmup tag are skipped" : ""}.</p>
                {err("warmup")}
              </Card>
            </div>
            <div className="callout tone-info">
              <Info size={15} strokeWidth={1.75} />
              <span>{dryRun ? "Dry run is on: changes are checked and logged, but Smartlead isn't changed." : "Outbound changes and warmup on/off go to Smartlead within a minute, one inbox at a time; each inbox shows Pending until Smartlead confirms."}</span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
