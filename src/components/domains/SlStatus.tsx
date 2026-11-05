import { SL_META, slShort, slState, slText, type SlCounts } from "@/lib/smartlead-state";

/** The domain's Smartlead status as of the last sync, as a small badge. */
export function SlBadge({ c, quiet = false, short = false }: { c: SlCounts; quiet?: boolean; short?: boolean }) {
  const s = slState(c);
  const m = SL_META[s];
  // Quiet: say nothing when everything is fine (beside a domain name).
  if (quiet && s === "live") return null;
  return (
    <span className={`sl-badge tone-${m.tone}`} title={`${m.hint}${c.slRemoved && s !== "deleted" ? `. ${c.slRemoved} more deleted in Smartlead` : ""}`}>
      <i aria-hidden /><span>{short ? slShort(c) : slText(c)}</span>
    </span>
  );
}
