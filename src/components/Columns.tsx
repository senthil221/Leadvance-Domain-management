"use client";

import { DropdownMenu } from "radix-ui";
import { Check, Columns3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

// Per-table column visibility. The choice is remembered in this browser only
// (it is a viewing preference), and the page renders fine without it.

export type ColumnDef<K extends string = string> = { key: K; label: string; hidden?: boolean; locked?: boolean };

export function useColumns<K extends string>(table: string, defs: ColumnDef<K>[]) {
  const defaults = useMemo(() => new Set(defs.filter((d) => d.hidden).map((d) => d.key)), [defs]);
  const [hidden, setHidden] = useState<Set<K>>(defaults);
  const storageKey = `cols:${table}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      // Restoring a saved preference after hydration is the point of this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setHidden(new Set((JSON.parse(raw) as K[]).filter((k) => defs.some((d) => d.key === k && !d.locked))));
    } catch { /* storage unavailable: keep defaults */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const save = (next: Set<K>) => {
    setHidden(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
  };
  const toggle = (k: K) => { const n = new Set(hidden); if (n.has(k)) n.delete(k); else n.add(k); save(n); };
  const reset = () => { save(new Set(defaults)); };
  const on = useCallback((k: K) => !hidden.has(k), [hidden]);
  return { on, hidden, toggle, reset, defs, count: defs.length - hidden.size };
}

export function ColumnsMenu<K extends string>({ cols }: { cols: ReturnType<typeof useColumns<K>> }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="btn btn-sm" aria-label="Choose columns"><Columns3 size={14} /> Columns</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 200, maxHeight: 420, overflowY: "auto" }}>
          <DropdownMenu.Label className="menu-label">Show columns</DropdownMenu.Label>
          {cols.defs.map((d) => (
            <DropdownMenu.CheckboxItem key={d.key} className="menu-item" checked={cols.on(d.key)} disabled={d.locked}
              onSelect={(e) => e.preventDefault()} onCheckedChange={() => cols.toggle(d.key)}>
              <span className="grid w-4 place-items-center">{cols.on(d.key) ? <Check size={13} /> : null}</span>
              <span className={d.locked ? "text-faint" : undefined}>{d.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item" onSelect={(e) => { e.preventDefault(); cols.reset(); }}>Reset to default</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
