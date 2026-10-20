"use client";

import { Dialog } from "radix-ui";
import { Info, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateInboxSettings } from "@/app/actions";
import { int } from "@/lib/format";

type LimitMode = "keep" | "set" | "random" | "split";
type Current = { dailyLimit: number | null; minWait: number | null; warmupPerDay: number | null; warmupRampup: number | null; warmupReplyRate: number | null };

const numOrUndef = (s: string) => (s.trim() === "" ? undefined : Math.max(0, Math.round(Number(s))));

function Num({ id, label, v, set, placeholder, max }: { id: string; label: string; v: string; set: (s: string) => void; placeholder?: string; max?: number }) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} className="input num" inputMode="numeric" type="number" min={0} max={max} value={v} onChange={(e) => set(e.target.value)} placeholder={placeholder ?? "Keep"} />
    </label>
  );
}

// Bulk edit of what Smartlead calls an inbox's general and warmup settings.
// Blank fields are left alone; the daily limit can be one value, a random
// value per inbox, or a total split across the selection.
export function InboxSettingsDialog({ open, onOpenChange, inboxIds, domains, current, dryRun, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inboxIds: string[];
  domains: number;
  current: Current;
  dryRun: boolean;
  onDone?: () => void;
}) {
  const n = inboxIds.length;
  const [mode, setMode] = useState<LimitMode>("keep");
  const [value, setValue] = useState("");
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [total, setTotal] = useState("");
  const [minWait, setMinWait] = useState("");
  const [warm, setWarm] = useState<"keep" | "on" | "off">("keep");
  const [perDay, setPerDay] = useState("");
  const [rampup, setRampup] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const key = open ? inboxIds.join(",") : null;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    if (key !== null) {
      setMode("keep"); setValue(""); setLo(""); setHi(""); setTotal(""); setMinWait("");
      setWarm("keep"); setPerDay(""); setRampup(""); setReply(""); setError(null);
    }
  }

  const loN = Number(lo), hiN = Number(hi), totalN = Number(total);
  const splitHint = mode === "split" && lo && hi && total
    ? totalN < n * loN ? `Too low: ${n} inbox${n === 1 ? "" : "es"} at ${loN} each is already ${int(n * loN)}. It will be raised to that.`
      : totalN > n * hiN ? `Too high: ${n} inbox${n === 1 ? "" : "es"} at ${hiN} each carry at most ${int(n * hiN)}. It will be capped there.`
      : `About ${(totalN / n).toFixed(1)} per inbox, each between ${loN} and ${hiN}.`
    : null;

  const submit = () => {
    setError(null);
    // A blank box must never be read as 0: that would stop the inboxes sending.
    const missing =
      mode === "set" && value.trim() === "" ? "Enter the emails per day"
      : (mode === "random" || mode === "split") && (lo.trim() === "" || hi.trim() === "") ? "Enter the lowest and highest per inbox"
      : mode === "split" && total.trim() === "" ? "Enter the total per day"
      : null;
    if (missing) return void setError(missing);
    const dailyLimit =
      mode === "set" ? { mode, value: numOrUndef(value) ?? 0 }
      : mode === "random" ? { mode, min: numOrUndef(lo) ?? 0, max: numOrUndef(hi) ?? 0 }
      : mode === "split" ? { mode, total: numOrUndef(total) ?? 0, min: numOrUndef(lo) ?? 0, max: numOrUndef(hi) ?? 0 }
      : { mode: "keep" as const };
    start(async () => {
      const r = await updateInboxSettings({
        inboxIds,
        dailyLimit,
        minWait: numOrUndef(minWait),
        warmupEnabled: warm === "keep" ? undefined : warm === "on",
        warmupPerDay: numOrUndef(perDay),
        warmupRampup: numOrUndef(rampup),
        warmupReplyRate: numOrUndef(reply),
      });
      if (!r.ok) return void setError(r.error);
      onOpenChange(false);
      onDone?.();
      toast.success(`${dryRun ? "Dry run: " : ""}Updating ${r.data.queued} inbox${r.data.queued === 1 ? "" : "es"}`, {
        description: `${r.data.total != null ? `${int(r.data.total)} campaign emails a day in total. ` : ""}${dryRun ? "Smartlead won't be changed while dry run is on." : "Sent to Smartlead within a minute."}`,
      });
    });
  };

  const ph = (x: number | null, unit = "") => (x == null ? "Keep" : `Keep (now ~${Math.round(x)}${unit})`);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog is-wide">
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">Edit {int(n)} inbox{n === 1 ? "" : "es"}</Dialog.Title>
            <Dialog.Description className="dialog-desc">
              On {domains} domain{domains === 1 ? "" : "s"}. Leave a field blank to keep what each inbox has now.
            </Dialog.Description>
          </div>
          <div className="dialog-body">
            <div className="field">
              <span className="field-label">Campaign emails per day, per inbox</span>
              <div className="seg" role="group" aria-label="Daily limit">
                {([["keep", "Keep"], ["set", "Same for all"], ["random", "Random per inbox"], ["split", "Split a total"]] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>{label}</button>
                ))}
              </div>
            </div>
            {mode === "set" ? (
              <div className="grid gap-3 sm:grid-cols-3"><Num id="limit" label="Emails per day" v={value} set={setValue} placeholder={ph(current.dailyLimit)} max={1000} /></div>
            ) : mode === "random" || mode === "split" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {mode === "split" ? <Num id="total" label="Total per day, all inboxes" v={total} set={setTotal} placeholder={current.dailyLimit != null ? `now ${int(Math.round(current.dailyLimit * n))}` : ""} /> : null}
                <Num id="lo" label="Lowest per inbox" v={lo} set={setLo} placeholder="e.g. 12" max={1000} />
                <Num id="hi" label="Highest per inbox" v={hi} set={setHi} placeholder="e.g. 18" max={1000} />
              </div>
            ) : null}
            {splitHint ? <p className="field-hint">{splitHint}</p> : null}
            {mode === "random" ? <p className="field-hint">Each inbox gets its own number between the two, once. For a new mix every day, create a daily plan.</p> : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <Num id="wait" label="Minimum minutes between emails" v={minWait} set={setMinWait} placeholder={ph(current.minWait, " min")} max={1440} />
            </div>

            <div className="field">
              <span className="field-label">Warmup</span>
              <div className="seg" role="group" aria-label="Warmup">
                {([["keep", "Keep"], ["on", "On"], ["off", "Off"]] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={warm === k} onClick={() => setWarm(k)}>{label}</button>
                ))}
              </div>
            </div>
            {warm !== "off" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Num id="perday" label="Warmup emails per day" v={perDay} set={setPerDay} placeholder={ph(current.warmupPerDay)} max={200} />
                <Num id="rampup" label="Daily ramp-up" v={rampup} set={setRampup} placeholder={ph(current.warmupRampup)} max={200} />
                <Num id="reply" label="Reply rate %" v={reply} set={setReply} placeholder={ph(current.warmupReplyRate, "%")} max={100} />
              </div>
            ) : null}

            <div className="callout tone-info">
              <Info size={15} strokeWidth={1.75} />
              <span>{dryRun ? "Dry run is on: the changes are queued and checked, but Smartlead isn't changed." : "Changes go to Smartlead within a minute, one inbox at a time. Each inbox shows Pending until Smartlead confirms."}</span>
            </div>
            {error ? <div className="callout tone-danger" role="alert"><TriangleAlert size={15} strokeWidth={1.75} /><span>{error}</span></div> : null}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>{pending ? "Saving…" : `Update ${int(n)} inbox${n === 1 ? "" : "es"}`}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
