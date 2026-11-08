// The smaller state machines beside the domain lifecycle (src/lib/status.ts):
// inboxes, the two work queues and what the email vendors say about orders and
// mailboxes. Each list matches the database column's check constraint, and
// tests/state-machines.test.ts keeps them identical. Diagrams and who moves
// what are in docs/state-machines.md. Shared by server and client.

/**
 * An inbox (inboxes.status). The Smartlead sync sets connected or
 * disconnected from Smartlead's own flag on every run, and removed once
 * Smartlead stops listing the account; an inbox that comes back is connected
 * or disconnected again. "pending" is the column default and nothing sets it.
 */
export const INBOX_STATUSES = ["pending", "connected", "disconnected", "removed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** Statuses a queued job is still open in: claimed rows go pending → running, then finish. */
export const OPEN_QUEUE_STATUSES = ["pending", "running"] as const;

/**
 * A queued nameserver change (nameserver_requests.status). The Set up dialog
 * adds pending (replacing any older pending one), the worker claims it as
 * running, then finishes it: done (set and read back), manual (a person has to
 * set the pair at the registrar), dry_run (only logged) or failed.
 */
export const NS_REQUEST_STATUSES = ["pending", "running", "done", "manual", "dry_run", "failed"] as const;
export type NsRequestStatus = (typeof NS_REQUEST_STATUSES)[number];

/**
 * A queued inbox setting change for Smartlead (inbox_setting_changes.status):
 * pending → running → done, dry_run or failed. Unlike nameservers there's no
 * manual end: every change can go through the API.
 */
export const SETTING_CHANGE_STATUSES = ["pending", "running", "done", "dry_run", "failed"] as const;
export type SettingChangeStatus = (typeof SETTING_CHANGE_STATUSES)[number];

// Hypertide orders (hypertide_orders.status and payment_status) are Hypertide's
// own words, stored as given: Todo, In progress, Done, NPC or Cancelled, and
// Paid or Unpaid (or a recovery-pool payment). The SQL checks the same words.

/** A finished order: its inboxes are set up. Hypertide only replaces domains on a Done order. */
export const HT_DONE = "Done";
/** Cancelled orders. NPC is what the API says for what Hypertide's dashboard shows as Cancelled. */
export const HT_CANCELLED = ["NPC", "Cancelled"] as const;
export const isHtCancelled = (status: string | null | undefined) => status != null && (HT_CANCELLED as readonly string[]).includes(status);
/** The payment says the domain is in Hypertide's recovery pool. */
export const inRecoveryPool = (payment: string | null | undefined) => /recovery/i.test(payment ?? "");

// Icemail mailboxes (icemail_mailboxes.status) are Icemail's words too. Only
// the SQL reads them: a mailbox has ended once Icemail stops listing it
// (gone_at) or its status matches cancel or delet (replace_dropped_domains, 0037).
