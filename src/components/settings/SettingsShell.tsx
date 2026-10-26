"use client";

import { Building2, Flame, PlugZap, RefreshCw, Workflow, type LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";

const ICONS = { connections: PlugZap, sync: RefreshCw, warmup: Flame, clients: Building2, lifecycle: Workflow } satisfies Record<string, LucideIcon>;
export type SectionKey = keyof typeof ICONS;
export type Section = { key: SectionKey; label: string; title: string; sub: string; badge?: ReactNode; content: ReactNode };

/** Settings, one section at a time: a sticky list of sections on the left, the chosen one on the right. */
export function SettingsShell({ sections }: { sections: Section[] }) {
  // Open the section in the address (?s=clients), and keep the address in step so it can be linked.
  const asked = useSearchParams().get("s");
  const [active, setActive] = useState<SectionKey>(() => sections.find((x) => x.key === asked)?.key ?? sections[0].key);
  const pick = (k: SectionKey) => {
    setActive(k);
    const p = new URLSearchParams(window.location.search);
    p.set("s", k);
    window.history.replaceState(null, "", `?${p.toString()}`);
  };
  const cur = sections.find((s) => s.key === active) ?? sections[0];

  return (
    <div className="st-shell">
      <nav className="st-nav" aria-label="Settings sections">
        {sections.map((s) => {
          const Icon = ICONS[s.key];
          return (
            <button key={s.key} type="button" className="st-nav-item" aria-current={s.key === cur.key ? "page" : undefined} onClick={() => pick(s.key)}>
              <Icon size={15} strokeWidth={1.6} />
              <span>{s.label}</span>
              {s.badge ? <span className="st-nav-badge">{s.badge}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="st-main" key={cur.key}>
        <header className="st-head">
          <h2 className="st-title">{cur.title}</h2>
          <p className="st-sub">{cur.sub}</p>
        </header>
        <div className="st-body">{cur.content}</div>
      </div>
    </div>
  );
}

/** A titled block inside a section. */
export function Panel({ title, sub, aside, children, flush }: { title: string; sub?: string; aside?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="flex flex-col gap-0.5">
          <span className="st-panel-title">{title}</span>
          {sub ? <span className="st-panel-sub">{sub}</span> : null}
        </span>
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      <div className={flush ? undefined : "st-panel-body"}>{children}</div>
    </section>
  );
}
