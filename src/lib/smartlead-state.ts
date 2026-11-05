// Where a domain stands in Smartlead right now, from its inboxes as of the
// last Smartlead sync: every inbox connected, some or all disconnected, all
// deleted in Smartlead, or never there. Shared by server and client.

export type SlCounts = { slConnected: number; slDisconnected: number; slRemoved: number };
export type SlState = "live" | "partial" | "disconnected" | "deleted" | "none";

export const SL_META: Record<SlState, { label: string; tone: "success" | "warning" | "danger" | "faint"; hint: string }> = {
  live: { label: "Live", tone: "success", hint: "Every inbox is connected in Smartlead" },
  partial: { label: "Partly disconnected", tone: "warning", hint: "Some inboxes are disconnected in Smartlead" },
  disconnected: { label: "Disconnected", tone: "danger", hint: "Every inbox is disconnected in Smartlead: reconnect them or replace the domain" },
  deleted: { label: "Deleted in Smartlead", tone: "faint", hint: "Every inbox was deleted in Smartlead: older numbers are history, nothing left to fix" },
  none: { label: "Not in Smartlead", tone: "faint", hint: "No inbox on this domain has been in Smartlead" },
};
export const SL_ORDER: SlState[] = ["live", "partial", "disconnected", "deleted", "none"];

export function slState(c: SlCounts): SlState {
  if (c.slConnected && c.slDisconnected) return "partial";
  if (c.slConnected) return "live";
  if (c.slDisconnected) return "disconnected";
  if (c.slRemoved) return "deleted";
  return "none";
}

/** The badge text: "Live · 5", "2 of 5 disconnected", "Deleted in Smartlead". */
export function slText(c: SlCounts): string {
  const s = slState(c);
  if (s === "live") return `Live · ${c.slConnected}`;
  if (s === "partial") return `${c.slDisconnected} of ${c.slConnected + c.slDisconnected} disconnected`;
  if (s === "disconnected") return `Disconnected · ${c.slDisconnected}`;
  return SL_META[s].label;
}

/** The same in a narrow column headed Smartlead: "Live · 5", "2 of 5 off", "Deleted". Never there says nothing. */
export function slShort(c: SlCounts): string {
  const s = slState(c);
  if (s === "partial") return `${c.slDisconnected} of ${c.slConnected + c.slDisconnected} off`;
  if (s === "deleted") return "Deleted";
  if (s === "none") return "—";
  return slText(c);
}
