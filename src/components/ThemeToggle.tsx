"use client";
import { useSyncExternalStore } from "react";
import { Moon, Rows3, Rows4, Sun } from "lucide-react";

import { DENSITY_KEY, THEME_KEY } from "./theme-script";
type Theme = "light" | "dark";

// The theme lives on <html data-theme>, set before paint by the script in the
// root layout; this button only flips it and remembers the choice.
const watch = (attr: string) => (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [attr] });
  return () => observer.disconnect();
};
const subscribe = watch("data-theme");
const current = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function toggleTheme() {
  const next: Theme = current() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: the choice lasts this visit */ }
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "light" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="icon-btn" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={toggleTheme}>
      {theme === "dark" ? <Sun size={16} strokeWidth={1.5} aria-hidden="true" /> : <Moon size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

// Compact view: shorter rows, tighter cards and headers, same columns.
// Lives on <html data-density="compact"> like the theme.
const subscribeDensity = watch("data-density");
const isCompact = () => document.documentElement.dataset.density === "compact";

export function useCompact() {
  return useSyncExternalStore(subscribeDensity, isCompact, () => false);
}

export function toggleDensity() {
  const compact = !isCompact();
  if (compact) document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
  try { localStorage.setItem(DENSITY_KEY, compact ? "compact" : "comfortable"); } catch { /* private mode */ }
}

export function DensityToggle() {
  const compact = useCompact();
  const label = compact ? "Switch to roomy view" : "Switch to compact view";
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} aria-pressed={compact} onClick={toggleDensity}>
      {compact ? <Rows3 size={16} strokeWidth={1.5} aria-hidden="true" /> : <Rows4 size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}
