"use client";

import { useState, type ReactNode } from "react";
import type { Tone } from "@/lib/status";

export type OverviewTab = { key: string; label: string; count?: number; tone?: Tone; content: ReactNode };

/** Several lists in the space of one card; the first is the most pressing. */
export function OverviewTabs({ tabs, id, label }: { tabs: OverviewTab[]; id?: string; label: string }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <section className="card ov-area-issues" id={id} aria-label={label} style={{ scrollMarginTop: 72 }}>
      <div className="ov-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" className="ov-tab" aria-selected={t.key === current?.key} onClick={() => setActive(t.key)}>
            {t.label}
            {t.count ? <span className={`ov-tab-n tone-${t.tone ?? "faint"}`}>{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel">{current?.content}</div>
    </section>
  );
}
