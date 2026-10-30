"use client";

import { CalendarDays, Loader } from "lucide-react";
import { useState } from "react";
import { PRESETS, daysBetween, matchPreset, nice, presetRange, type PresetKey } from "@/lib/range";

/** A date range: a preset, or two dates and Apply. Calls onChange with the new range. */
export function RangePicker({ from, to, today, loading, onChange, initial = matchPreset(from, to, today) }: {
  from: string; to: string; today: string; loading?: boolean;
  onChange: (from: string, to: string) => void;
  initial?: PresetKey;
}) {
  const [preset, setPreset] = useState<PresetKey>(initial);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const pick = (k: PresetKey) => {
    setPreset(k);
    const r = presetRange(k, today);
    if (r) { setF(r[0]); setT(r[1]); onChange(r[0], r[1]); }
  };
  const label = from === to ? nice(from) : `${nice(from)} – ${nice(to)} · ${daysBetween(from, to)} days`;
  return (
    <>
      <label className="flex items-center gap-1.5">
        <CalendarDays size={14} className="text-faint" />
        <select className="select" style={{ width: 130 }} value={preset} onChange={(e) => pick(e.target.value as PresetKey)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </label>
      {preset === "custom" ? (
        <span className="flex items-center gap-1.5">
          <input type="date" className="input" style={{ width: 138 }} value={f} max={today} onChange={(e) => setF(e.target.value)} aria-label="From" />
          <span className="text-faint">–</span>
          <input type="date" className="input" style={{ width: 138 }} value={t} max={today} onChange={(e) => setT(e.target.value)} aria-label="To" />
          <button type="button" className="btn btn-sm btn-primary" disabled={!f || !t || loading} onClick={() => onChange(f, t)}>Apply</button>
        </span>
      ) : <span className="text-[12.5px] text-muted">{label}</span>}
      {loading ? <Loader size={14} className="animate-spin text-faint" aria-label="Loading" /> : null}
    </>
  );
}
