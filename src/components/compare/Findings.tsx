"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, CircleCheck, ShieldCheck, Sparkles, TriangleAlert, TrendingUp } from "lucide-react";
import { findings, MIN_SENT, type Dim, type Finding } from "@/lib/compare";
import { int } from "@/lib/format";
import type { ReviewDomain } from "@/lib/review";

const SHOWN = 3;

/**
 * What stands out in these domains: the claim, why it's the group or its age or
 * its lists, how sure that is, and what to do about it.
 */
export function Findings({ domains, compareLink = false, dims, limit = 6, volumeDrop = null, onShow }: {
  domains: ReviewDomain[]; compareLink?: boolean; dims?: Dim[]; limit?: number; volumeDrop?: number | null;
  /** Show a finding's domains on this page; without it, the button goes to Compare. */ onShow?: (f: Finding) => void;
}) {
  const list = useMemo(() => findings(domains, dims, limit, { volumeDrop }), [domains, dims, limit, volumeDrop]);
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <section className="card" aria-labelledby="findings-title">
      <div className="card-head">
        <h2 id="findings-title" className="card-title inline-flex items-center gap-2"><Sparkles size={13} strokeWidth={1.75} className="text-faint" aria-hidden="true" />What stands out</h2>
        <span className="card-sub">Differences too big to be chance on {int(MIN_SENT)}+ sent, and what the servers said</span>
        {compareLink ? <Link href="/compare" className="card-link">Compare <ArrowUpRight size={13} strokeWidth={1.5} /></Link> : null}
      </div>
      {list.length ? (
        <>
          <div className="cmp-findings">
            {shown.map((f) => {
              const Icon = f.tone === "success" ? TrendingUp : TriangleAlert;
              const link = f.href ?? (!onShow && f.dim ? `/compare?dim=${f.dim}&group=${encodeURIComponent(f.groupKey ?? "")}` : null);
              return (
                <article key={f.id} className={`cmp-finding tone-${f.tone}`}>
                  <span className="cmp-finding-icon"><Icon size={14} strokeWidth={1.75} aria-hidden="true" /></span>
                  <div className="cmp-finding-body">
                    <h3 className="cmp-finding-title">{f.title}</h3>
                    <p className="cmp-finding-verdict">{f.verdict}</p>
                    {f.detail.length ? <p className="cmp-finding-detail">{f.detail.join(" · ")}</p> : null}
                    <p className="cmp-finding-action"><ArrowRight size={12} strokeWidth={2} aria-hidden="true" />{f.action}</p>
                    <div className="cmp-finding-foot">
                      {f.sure ? <span className="cmp-finding-sure"><ShieldCheck size={12} strokeWidth={1.75} aria-hidden="true" />{f.sure}</span> : null}
                      {link ? <Link href={link} className="cmp-finding-show">{f.href ? "Open the client" : `Show ${int(f.domainIds.length)} domains`}</Link>
                        : onShow ? <button type="button" className="cmp-finding-show" onClick={() => onShow(f)}>Show {int(f.domainIds.length)} domains</button> : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          {list.length > SHOWN ? <button type="button" className="cmp-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${list.length - SHOWN} more`}</button> : null}
        </>
      ) : (
        <p className="card-body cmp-none"><CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" /> Nothing stands out: bounces and human replies are about the same across these groups, and no block list or DNS problem shows up.</p>
      )}
    </section>
  );
}
