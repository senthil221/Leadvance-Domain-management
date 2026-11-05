"use client";

import { useState, type ReactNode } from "react";

/** The registrar account and TLD counts as one table each, one at a time, so their columns line up with the page. */
export function BreakdownTabs({ accounts, tlds, accountCount, tldCount }: { accounts: ReactNode; tlds: ReactNode; accountCount: number; tldCount: number }) {
  const [tab, setTab] = useState<"accounts" | "tlds">("accounts");
  return (
    <section className="card" aria-label="Domains by registrar account or TLD">
      <div className="card-head">
        <div className="seg" role="group" aria-label="Break down by">
          <button type="button" aria-pressed={tab === "accounts"} onClick={() => setTab("accounts")}>Registrar accounts ({accountCount})</button>
          <button type="button" aria-pressed={tab === "tlds"} onClick={() => setTab("tlds")}>TLDs ({tldCount})</button>
        </div>
        <span className="card-sub" title="Every login in Settings → Connections. No registrar account: domains Hypertide or Smartlead know about that no connected account holds.">Click a row or number to list those domains</span>
      </div>
      {tab === "accounts" ? accounts : tlds}
    </section>
  );
}
