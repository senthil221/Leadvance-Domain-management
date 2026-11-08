"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";

// Filters that stay put while you move between tabs and pages. They live in this
// browser tab's session storage, so a new tab or a closed browser starts clean,
// and the page renders fine without storage. A value the address names (a link
// to ?registrar=… or ?client=…) wins over the remembered one.

const PREFIX = "filters:";
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try { return window.sessionStorage.getItem(PREFIX + key); } catch { return null; }
}

function write(key: string, raw: string | null) {
  if (read(key) === raw) return;
  try {
    if (raw === null) window.sessionStorage.removeItem(PREFIX + key);
    else window.sessionStorage.setItem(PREFIX + key, raw);
  } catch { /* storage unavailable: the filter just isn't remembered */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Like useState, but remembered for the session under `key`. `fromUrl` is the
 * value the address gives, or null when it gives none.
 */
export function useSticky<T>(key: string, fallback: T, fromUrl: T | null = null): [T, (next: T | ((prev: T) => T)) => void] {
  // Before hydration there's no storage: render what the server rendered.
  const raw = useSyncExternalStore(subscribe, () => read(key), () => undefined);
  const urlRaw = fromUrl === null ? null : JSON.stringify(fromUrl);
  const fallbackRaw = JSON.stringify(fallback);

  // Take the address's value before the browser paints, so nothing flickers.
  useLayoutEffect(() => {
    if (urlRaw !== null) write(key, urlRaw === fallbackRaw ? null : urlRaw);
  }, [key, urlRaw, fallbackRaw]);

  // Parsed once per stored string, so objects and arrays keep their identity between renders.
  const value = useMemo(
    () => parse<T>(raw === undefined ? urlRaw ?? fallbackRaw : raw ?? urlRaw ?? fallbackRaw, JSON.parse(fallbackRaw) as T),
    [raw, urlRaw, fallbackRaw],
  );

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const prev = parse(read(key), JSON.parse(fallbackRaw) as T);
    const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    const s = JSON.stringify(v);
    // The default isn't stored, so clearing a filter leaves nothing behind, unless
    // the address still names a value that would otherwise come back.
    write(key, s === fallbackRaw && urlRaw === null ? null : s);
  }, [key, fallbackRaw, urlRaw]);

  return [value, set];
}
