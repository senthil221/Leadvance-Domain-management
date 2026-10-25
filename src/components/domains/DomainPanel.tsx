"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DomainSheet } from "./DomainSheet";
import type { PanelTab } from "./DomainLink";
import { ReplaceDialog, type ReplaceTarget } from "./ReplaceDialog";

const TABS: PanelTab[] = ["overview", "inboxes", "stats", "history"];

/**
 * The one domain panel for the whole app. It follows ?d=<domain> (and ?tab=)
 * in the address, so any page can open it without leaving the page.
 */
export function DomainPanel() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [replace, setReplace] = useState<ReplaceTarget[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const id = params.get("d");
  const tabParam = params.get("tab") as PanelTab | null;
  const tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";

  const go = (next: { d?: string | null; tab?: string | null }) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  return (
    <>
      <DomainSheet
        domainId={id}
        initialTab={tab}
        reloadKey={reloadKey}
        onClose={() => go({ d: null, tab: null })}
        onOpenDomain={(next) => go({ d: next, tab: null })}
        onReplace={(d) => {
          go({ d: null, tab: null });
          setReplace([{ id: d.id, name: d.name, tld: d.tld, clientName: d.clientName, clientHue: d.clientHue }]);
        }}
      />
      <ReplaceDialog
        open={replace !== null}
        onOpenChange={(o) => !o && setReplace(null)}
        targets={replace ?? []}
        onDone={() => { setReplace(null); setReloadKey((k) => k + 1); router.refresh(); }}
      />
    </>
  );
}
