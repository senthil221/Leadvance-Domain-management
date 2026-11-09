"use client";

import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import {
  Children, Fragment, isValidElement, useMemo, useRef, useState,
  type ChangeEvent, type CSSProperties, type ReactElement, type ReactNode,
} from "react";

// A drop-in for <select>: the same <option> and <optgroup> children and the same
// onChange(e => e.target.value), drawn as a styled list that scrolls, finds an
// option as you type when there are many, and works from the keyboard.

type Opt = { value: string; text: string; disabled: boolean; group: string | null };

/** Reads <option>/<optgroup> children, through arrays and fragments, into a flat list. */
function collect(children: ReactNode, group: string | null = null, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ children?: ReactNode; value?: unknown; label?: string; disabled?: boolean }>;
    if (el.type === Fragment) collect(el.props.children, group, out);
    else if (el.type === "optgroup") collect(el.props.children, el.props.label ?? null, out);
    else if (el.type === "option") {
      const text = textOf(el.props.children);
      out.push({ value: el.props.value === undefined ? text : String(el.props.value), text, disabled: !!el.props.disabled, group });
    }
  });
  return out;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

/** "Amelia Wren (24)" → the name and a count shown apart, muted; anything else as is. */
function splitCount(text: string): { label: string; count: string | null } {
  const m = /^(.*\S)\s+\((\d[\d,.]*)\)$/.exec(text);
  return m ? { label: m[1], count: m[2] } : { label: text, count: null };
}

/** Past this many options the list gets a search box. */
const SEARCH_FROM = 8;

type Props = {
  value?: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  id?: string;
  "aria-label"?: string;
  "data-on"?: boolean;
};

export function Select({ value, onChange, children, className = "select", style, disabled, title, id, "aria-label": ariaLabel, "data-on": dataOn }: Props) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => collect(children), [children]);
  const current = String(value ?? "");
  const chosen = options.find((o) => o.value === current) ?? null;
  const searchable = options.length >= SEARCH_FROM;
  // Grouped as the <optgroup>s were, in order.
  const groups = useMemo(() => {
    const out: { name: string | null; opts: (Opt & { i: number })[] }[] = [];
    options.forEach((o, i) => {
      const last = out[out.length - 1];
      if (last && last.name === o.group) last.opts.push({ ...o, i });
      else out.push({ name: o.group, opts: [{ ...o, i }] });
    });
    return out;
  }, [options]);

  // A width given for the old <select> is a floor: the button grows to show its
  // whole label ("This and last week") instead of cutting it off, up to a cap.
  const { width, ...restStyle } = style ?? {};
  const triggerStyle: CSSProperties | undefined = width == null ? style : { ...restStyle, minWidth: width, maxWidth: 320 };

  const pick = (v: string) => {
    setOpen(false);
    if (v === current) return;
    // Shaped like a <select>'s change event, so existing handlers read e.target.value.
    const target = { value: v } as HTMLSelectElement;
    onChange?.({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button type="button" id={id} className={`${className} dd-trigger`} style={triggerStyle} title={title ?? chosen?.text} aria-label={ariaLabel}
          data-on={dataOn || undefined} data-empty={chosen ? undefined : true} disabled={disabled}>
          <span className="dd-value">{chosen ? <Label text={chosen.text} /> : null}</span>
          <ChevronDown size={14} strokeWidth={1.75} className="dd-chevron" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="dd-panel" align="start" sideOffset={4} collisionPadding={12}
          onOpenAutoFocus={(e) => {
            // Focus the search box (or the list) and bring the current option into view.
            e.preventDefault();
            requestAnimationFrame(() => {
              const root = listRef.current?.closest(".dd-panel");
              (root?.querySelector<HTMLElement>("input") ?? root?.querySelector<HTMLElement>("[cmdk-root]"))?.focus();
              listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: "nearest" });
            });
          }}>
          <Command loop defaultValue={chosen ? `o${options.indexOf(chosen)}` : undefined}
            filter={(_v, search, keywords) => ((keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
            {searchable ? (
              <label className="dd-search">
                <Search size={13} strokeWidth={1.75} aria-hidden />
                <Command.Input placeholder="Search…" aria-label={ariaLabel ? `Search ${ariaLabel.toLowerCase()}` : "Search"} />
              </label>
            ) : null}
            <Command.List ref={listRef} className="dd-list">
              <Command.Empty className="dd-empty">Nothing matches</Command.Empty>
              {groups.map((g, gi) => {
                const items = g.opts.map((o) => (
                  <Command.Item key={o.i} value={`o${o.i}`} keywords={[o.text, g.name ?? ""]} disabled={o.disabled}
                    className="dd-item" data-current={o.value === current} onSelect={() => pick(o.value)}>
                    <Label text={o.text} itemClass="dd-item-text" />
                    <span className="dd-tick" aria-hidden>{o.value === current ? <Check size={14} strokeWidth={2.25} className="dd-check" /> : null}</span>
                  </Command.Item>
                ));
                return g.name ? <Command.Group key={gi} heading={g.name} className="dd-group">{items}</Command.Group> : <Fragment key={gi}>{items}</Fragment>;
              })}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** An option's text, with a trailing "(24)" shown as a separate muted count. */
function Label({ text, itemClass = "dd-value-text" }: { text: string; itemClass?: string }) {
  const { label, count } = splitCount(text);
  return (
    <>
      <span className={itemClass}>{label}</span>
      {count ? <span className="dd-count">{count}</span> : null}
    </>
  );
}
