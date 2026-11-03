"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight, CircleCheck, Sparkles, TriangleAlert, TrendingUp } from "lucide-react";
import { findings, MIN_SENT } from "@/lib/compare";
import { int } from "@/lib/format";
import type { ReviewDomain } from "@/lib/review";

/** What stands out in these domains, and whether it's the group itself, their age or their lists. */
export function Findings({ domains, compareLink = false }: { domains: ReviewDomain[]; compareLink?: boolean }) {
  const list = useMemo(() => findings(domains), [domains]);
  return (
    <section className="card" aria-labelledby="findings-title">
      <div className="card-head">
        <h2 id="findings-title" className="card-title inline-flex items-center gap-2"><Sparkles size={13} strokeWidth={1.75} className="text-faint" aria-hidden="true" />What stands out</h2>
        <span className="card-sub">Only differences too big to be chance, on {int(MIN_SENT)}+ sent</span>
        {compareLink ? <Link href="/compare" className="card-link">Compare <ArrowUpRight size={13} strokeWidth={1.5} /></Link> : null}
      </div>
      {list.length ? (
        <div className="cmp-findings">
          {list.map((f) => {
            const Icon = f.tone === "success" ? TrendingUp : TriangleAlert;
            return (
              <article key={f.id} className={`cmp-finding tone-${f.tone}`}>
                <span className="cmp-finding-icon"><Icon size={14} strokeWidth={1.75} aria-hidden="true" /></span>
                <div className="min-w-0">
                  <h3 className="cmp-finding-title">{f.title}</h3>
                  <p className="cmp-finding-verdict">{f.verdict}</p>
                  {f.detail.length ? <p className="cmp-finding-detail">{f.detail.join(" · ")}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="card-body cmp-none"><CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" /> Nothing stands out: bounces and human replies are about the same across TLDs, providers, tags and domain ages.</p>
      )}
    </section>
  );
}
