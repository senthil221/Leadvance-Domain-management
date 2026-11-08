"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { toast } from "sonner";

// Shared table helpers: shift-click to select a run of rows, copying domain
// names, and columns you can drag wider or narrower.

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

type SetSelected = (f: (s: Set<string>) => Set<string>) => void;

/**
 * Click picks one row; shift-click picks every row between it and the last one
 * clicked, in the order shown. The run takes the clicked row's new state, so a
 * shift-click on a ticked row unticks the run.
 */
export function useRangeSelect(ids: string[], setSelected: SetSelected) {
  const anchor = useRef<string | null>(null);
  return useCallback((id: string, e?: { shiftKey?: boolean }) => {
    const from = anchor.current;
    anchor.current = id;
    setSelected((s) => {
      const n = new Set(s);
      const on = !s.has(id);
      const a = e?.shiftKey && from ? ids.indexOf(from) : -1;
      const b = ids.indexOf(id);
      const run = a >= 0 && b >= 0 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
      for (const x of run) if (on) n.add(x); else n.delete(x);
      return n;
    });
  }, [ids, setSelected]);
}

/** Stops shift-click from highlighting the text between the two rows. */
export const keepTextUnselected = (e: MouseEvent) => { if (e.shiftKey) e.preventDefault(); };

/** Copies text, falling back to the older copy command when the browser refuses the clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
  }
}

export function copyDomains(names: string[]) {
  const list = [...new Set(names)];
  if (!list.length) return;
  void copyText(list.join("\n")).then((ok) => {
    if (ok) toast.success(`Copied ${list.length} domain${list.length === 1 ? "" : "s"}, one per line`);
    else toast.error("Couldn't copy: the browser blocked the clipboard");
  });
}

// ---------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------

// Remembered in this browser per table, like the choice of columns.
const MIN_WIDTH = 48, MAX_WIDTH = 720;
const widthListeners = new Set<() => void>();
const subscribeWidths = (l: () => void) => { widthListeners.add(l); return () => { widthListeners.delete(l); }; };
// While dragging, widths change many times a second: keep them in memory and save once on release.
const live = new Map<string, string | null>();

function readWidths(key: string): string | null {
  if (live.has(key)) return live.get(key) ?? null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeWidths(key: string, raw: string | null, save: boolean) {
  live.set(key, raw);
  if (save) {
    live.delete(key);
    try { if (raw === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, raw); } catch { /* not remembered */ }
  }
  for (const l of widthListeners) l();
}

export function useColumnWidths(table: string, defaults: Record<string, number>) {
  const key = `col-widths:${table}`;
  const raw = useSyncExternalStore(subscribeWidths, () => readWidths(key), () => null);
  const custom = useMemo<Record<string, number>>(() => {
    try { return raw ? (JSON.parse(raw) as Record<string, number>) : {}; } catch { return {}; }
  }, [raw]);
  const width = useCallback((col: string) => custom[col] ?? defaults[col], [custom, defaults]);
  const setWidth = useCallback((col: string, w: number, save = true) => {
    const next = { ...custom, [col]: Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))) };
    writeWidths(key, JSON.stringify(next), save);
  }, [custom, key]);
  const reset = useCallback(() => writeWidths(key, null, true), [key]);
  return { width, custom, setWidth, reset, customized: Object.keys(custom).length > 0 };
}

/** How wide a column must be to show every cell in full, from what's on screen. */
function fitWidth(th: HTMLTableCellElement) {
  const table = th.closest("table");
  if (!table) return null;
  const index = th.cellIndex;
  const cells: HTMLElement[] = [th];
  for (const row of Array.from(table.tBodies[0]?.rows ?? [])) {
    // Skip spacer rows and rows that span columns.
    if (row.cells.length === th.parentElement?.children.length) cells.push(row.cells[index]);
  }
  let need = 0;
  for (const cell of cells) {
    let short = Math.max(0, cell.scrollWidth - cell.clientWidth);
    for (const el of Array.from(cell.querySelectorAll<HTMLElement>("*"))) short = Math.max(short, el.scrollWidth - el.clientWidth);
    need = Math.max(need, cell.getBoundingClientRect().width + short);
  }
  return need ? Math.ceil(need) + 4 : null;
}

/**
 * The handle on a header's right edge: drag to resize, double-click to fit the
 * widest value, or focus it and use the arrow keys.
 */
export function ColResizer({ col, label, onResize }: { col: string; label: string; onResize: (col: string, width: number, save?: boolean) => void }) {
  const start = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    if (!th) return;
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    document.body.classList.add("is-col-resizing");
    // Listen on the window: the header can be redrawn mid-drag, and the pointer leaves the handle.
    const move = (ev: globalThis.PointerEvent) => onResize(col, w0 + ev.clientX - x0, false);
    const end = (ev: globalThis.PointerEvent) => {
      onResize(col, w0 + ev.clientX - x0, true);
      document.body.classList.remove("is-col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const fit = (e: MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    const w = th ? fitWidth(th) : null;
    if (w) onResize(col, w, true);
  };
  const keys = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const th = e.currentTarget.closest("th");
    if (th) onResize(col, th.getBoundingClientRect().width + (e.key === "ArrowRight" ? 16 : -16), true);
  };
  return (
    <span className="col-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize the ${label} column`} tabIndex={0}
      title="Drag to resize · double-click to fit" onPointerDown={start} onDoubleClick={fit} onClick={(e) => e.stopPropagation()} onKeyDown={keys} />
  );
}
