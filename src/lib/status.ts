export const DOMAIN_STATUSES = [
  "in_storage",
  "provisioning",
  "warming",
  "active",
  "draining",
  "burned",
  "resting",
] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export type Tone = "faint" | "info" | "success" | "warning" | "danger" | "violet" | "brand";

export const STATUS_META: Record<DomainStatus, { label: string; tone: Tone; live?: boolean; hint: string }> = {
  in_storage: { label: "In storage", tone: "faint", hint: "Owned and free to use" },
  provisioning: { label: "Provisioning", tone: "info", hint: "Nameservers and inboxes being set up" },
  warming: { label: "Warming", tone: "info", hint: "Connected to Smartlead, warmup only" },
  active: { label: "Active", tone: "success", live: true, hint: "Sending in campaigns" },
  draining: { label: "Draining", tone: "warning", hint: "Replaced, finishing current sequences" },
  burned: { label: "Burned", tone: "danger", hint: "Retired" },
  resting: { label: "Resting", tone: "violet", hint: "Cooling off before going back to storage" },
};

// The domain lifecycle. See docs/state-machines.md for the diagram.

// Moves the UI offers. Mirrors domain_transitions in the database, which is
// the source of truth and rejects anything else unless the move is forced;
// tests/state-machines.test.ts keeps the two identical.
export const NEXT_STATUSES: Record<DomainStatus, DomainStatus[]> = {
  in_storage: ["provisioning"],
  provisioning: ["warming", "in_storage"],
  warming: ["active", "draining"],
  active: ["warming", "draining"],
  draining: ["burned", "active"],
  burned: ["resting"],
  resting: ["in_storage"],
};

/** A move transition_domain() accepts without force. Staying put is always fine (it's a no-op). */
export const canMove = (from: DomainStatus, to: DomainStatus) => from === to || NEXT_STATUSES[from].includes(to);

/**
 * Moves the app makes on its own with force, because they skip the normal
 * path. Each is logged in domain_status_history with forced = true. None of
 * these may be added to domain_transitions: the tests check they still need force.
 */
export const FORCED_MOVES: { from: DomainStatus[]; to: DomainStatus; by: string; why: string }[] = [
  { from: ["in_storage", "provisioning"], to: "active", by: "smartlead sync", why: "Found sending in Smartlead (a daily limit is set)" },
  { from: ["in_storage"], to: "warming", by: "smartlead sync", why: "Found in Smartlead with no daily limit yet" },
  { from: ["active", "warming"], to: "burned", by: "auto replace (replace_dropped_domains)", why: "No inboxes left in Smartlead and nothing live at Hypertide or Icemail" },
  { from: ["burned"], to: "active", by: "auto replace (replace_dropped_domains)", why: "Its inboxes came back in Smartlead, with a daily limit" },
  { from: ["burned"], to: "warming", by: "auto replace (replace_dropped_domains)", why: "Its inboxes came back in Smartlead, no daily limit" },
  { from: ["in_storage", "provisioning", "warming", "active"], to: "burned", by: "Mark as replaced (person)", why: "Recording old data" },
  { from: ["in_storage", "provisioning", "warming", "active", "draining"], to: "resting", by: "Move to recovery (person)", why: "Resting a domain" },
];

/** Being set up or sending: what Expiring and Validate DNS count as in use. */
export const IN_USE_STATUSES = ["provisioning", "warming", "active"] as const satisfies readonly DomainStatus[];
/** What start_replacement() accepts as the old domain. */
export const REPLACEABLE_STATUSES = ["active", "warming"] as const satisfies readonly DomainStatus[];
/** The fleet bars on the Overview and per client, in the order they're drawn. */
export const FLEET_STATUSES = ["active", "warming", "provisioning", "draining"] as const satisfies readonly DomainStatus[];
/** Taken out of use here: domain_standing calls these retired, and Mark as replaced leaves them alone. */
export const RETIRED_STATUSES = ["draining", "burned", "resting"] as const satisfies readonly DomainStatus[];

export const isOneOf = <T extends string>(list: readonly T[], s: string | null | undefined): s is T => s != null && (list as readonly string[]).includes(s);

export const REPLACEMENT_REASONS = {
  high_bounce: "High bounce rate",
  low_replies: "Low or no replies",
  low_reputation: "Low warmup reputation",
  blacklisted: "Blacklisted",
  client_request: "Client request",
  expiring: "Expiring soon",
  other: "Other",
} as const;
export type ReplacementReason = keyof typeof REPLACEMENT_REASONS;

export const STEP_LABELS = {
  stepNameservers: "Nameservers",
  stepInboxes: "Inboxes",
  stepSmartlead: "Smartlead",
  stepCampaigns: "Campaigns",
} as const;
export type StepKey = keyof typeof STEP_LABELS;

/**
 * A replacement step (the step_status enum). The worker moves pending →
 * running → done, or parks the step on manual (a person has to do it) or
 * failed (Retry). A person can mark the current step done, skip it, or retry
 * it (back to pending). See docs/state-machines.md.
 */
export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped", "manual"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
/** Done or skipped: the pair moves on to the next step. */
export const isStepFinished = (s: string) => s === "done" || s === "skipped";
/** Manual or failed: the worker leaves it until a person acts. */
export const stepWaitsOnPerson = (s: string) => s === "manual" || s === "failed";

/**
 * A replacement batch (replacement_batches.status). Only running → completed
 * happens today: the worker completes a batch once every pair is finished.
 * "partial" and "cancelled" are allowed by the column but nothing sets them;
 * queries still skip cancelled batches so a hand-cancelled one drops out.
 */
export const BATCH_STATUSES = ["running", "completed", "partial", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

// Reply types, in the order the filter lists them. "human" is a person
// replying with interest or a question, shown as Interested.
export const REPLY_CLASS_META = {
  human: { label: "Interested", tone: "success" },
  referral: { label: "Referral", tone: "info" },
  negative: { label: "Not interested", tone: "warning" },
  wrong_person: { label: "Wrong person", tone: "violet" },
  unsubscribe: { label: "Unsubscribe", tone: "danger" },
  ooo: { label: "Out of office", tone: "faint" },
  auto: { label: "Auto-reply", tone: "faint" },
} as const satisfies Record<import("./classify").ReplyClass, { label: string; tone: Tone }>;
