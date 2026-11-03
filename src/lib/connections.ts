// What the order_connections view says about a domain with an active order.
// Shared by server and client.

export type ConnectionState = "disconnected" | "deleted" | "missing" | "dns_gone" | "warmup_off" | "warmup_blocked" | "setting_up" | "retiring" | "ok";
export type ConnectionProblem = Exclude<ConnectionState, "setting_up" | "retiring" | "ok">;

export const CONNECTION_PROBLEMS: Record<ConnectionProblem, { label: string; hint: string }> = {
  disconnected: { label: "Disconnected", hint: "The order is active, but inboxes are disconnected in Smartlead" },
  deleted: { label: "Deleted in Smartlead", hint: "The order is active, but every inbox was deleted in Smartlead" },
  missing: { label: "Not in Smartlead", hint: "The order is active, but Smartlead has no inboxes for the domain" },
  dns_gone: { label: "DNS gone", hint: "Inboxes show connected, but the domain's DNS doesn't answer, so mail fails" },
  warmup_off: { label: "Warm-up off", hint: "Connected, but warm-up is off on some inboxes" },
  warmup_blocked: { label: "Warm-up blocked", hint: "Connected, but Smartlead has blocked warm-up on some inboxes" },
};
