// Why an active domain is dead (the dead_domains view): nothing on it can
// send any more. Shared by server and client.

export type DeadCause = "tenant_deleted" | "signin_expired" | "mail_off" | "disconnected" | "deleted" | "dns_gone";

export const DEAD_CAUSES: Record<DeadCause, { label: string; hint: string }> = {
  tenant_deleted: { label: "Microsoft tenant deleted", hint: "Microsoft says the inbox accounts were deleted from their directory (AADSTS500341): the tenant is gone" },
  signin_expired: { label: "Microsoft sign-in expired", hint: "Smartlead's sign-in to the inboxes expired and they dropped out: reconnect them, or replace the domain" },
  mail_off: { label: "Google mail switched off", hint: "Google says mail service isn't enabled for the inboxes: the mailboxes were removed or the workspace suspended" },
  disconnected: { label: "All inboxes disconnected", hint: "Every inbox is disconnected in Smartlead" },
  deleted: { label: "All inboxes deleted in Smartlead", hint: "Every inbox on the domain was deleted in Smartlead" },
  dns_gone: { label: "DNS gone", hint: "Inboxes still show connected in Smartlead, but the domain's DNS doesn't answer: the zone or the registration is gone, so mail fails" },
};

export const isDeadCause = (v: unknown): v is DeadCause => typeof v === "string" && v in DEAD_CAUSES;
