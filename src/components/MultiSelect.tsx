"use client";

import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useRef, useState, type CSSProperties } from "react";

// A dropdown that picks several values, drawn like <Select> (the dd-* styles):
// each row has a tick box, the list stays open while you pick, and the first
// row clears the pick back to "all".

export type MultiOption = { value: string; label: string; count?: number };

/** Past this many options the list gets a search box. */
const SEARCH_FROM = 8;

export function MultiSelect({ options, value, onChange, allLabel, style, "aria-label": ariaLabel }: {
  options: MultiOption[];
  /** The values picked; empty means all. */
  value: string[];
  onChange: (value: string[]) => void;
  /** What an empty pick means, e.g. "All clients". */
  allLabel: string;
  style?: CSSProperties;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const picked = new Set(value);
  const chosen = options.filter((o) => picked.has(o.value));
  const label = chosen.length === 0 ? allLabel : chosen.length === 1 ? chosen[0].label : `${chosen[0].label} +${chosen.length - 1}`;

  const toggle = (v: string) => onChange(picked.has(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="select dd-trigger" style={{ width: "auto", ...style }} aria-label={ariaLabel}
          title={chosen.length > 1 ? chosen.map((o) => o.label).join(", ") : undefined} data-on={chosen.length ? true : undefined}>
          <span className="dd-value"><span className="dd-value-text">{label}</span></span>
          <ChevronDown size={14} strokeWidth={1.75} className="dd-chevron" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="dd-panel" align="start" sideOffset={4} collisionPadding={12}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => {
              const root = listRef.current?.closest(".dd-panel");
              (root?.querySelector<HTMLElement>("input") ?? root?.querySelector<HTMLElement>("[cmdk-root]"))?.focus();
            });
          }}>
          <Command loop
            filter={(_v, search, keywords) => ((keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
            {options.length >= SEARCH_FROM ? (
              <label className="dd-search">
                <Search size={13} strokeWidth={1.75} aria-hidden />
                <Command.Input placeholder="Search…" aria-label={ariaLabel ? `Search ${ariaLabel.toLowerCase()}` : "Search"} />
              </label>
            ) : null}
            <Command.List ref={listRef} className="dd-list">
              <Command.Empty className="dd-empty">Nothing matches</Command.Empty>
              <Command.Item value="__all" keywords={[allLabel]} className="dd-item" data-current={chosen.length === 0} onSelect={() => onChange([])}>
                <Box on={chosen.length === 0} />
                <span className="dd-item-text">{allLabel}</span>
              </Command.Item>
              {options.map((o, i) => (
                <Command.Item key={o.value || `none-${i}`} value={`o${i}`} keywords={[o.label]} className="dd-item"
                  data-current={picked.has(o.value)} onSelect={() => toggle(o.value)}>
                  <Box on={picked.has(o.value)} />
                  <span className="dd-item-text">{o.label}</span>
                  {o.count != null ? <span className="dd-count">{o.count}</span> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Box({ on }: { on: boolean }) {
  return <span className="dd-box" data-on={on || undefined} aria-hidden>{on ? <Check size={11} strokeWidth={3} /> : null}</span>;
}
