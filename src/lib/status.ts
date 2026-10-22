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

// Moves the UI offers. Mirrors domain_transitions in the database, which is
// the source of truth and rejects anything else.
export const NEXT_STATUSES: Record<DomainStatus, DomainStatus[]> = {
  in_storage: ["provisioning"],
  provisioning: ["warming", "in_storage"],
  warming: ["active", "draining"],
  active: ["draining"],
  draining: ["burned", "active"],
  burned: ["resting"],
  resting: ["in_storage"],
};

export const REPLACEMENT_REASONS = {
  high_bounce: "High bounce rate",
  low_replies: "Low or no replies",
  low_reputation: "Low warmup reputation",
  blacklisted: "Blacklisted",
  client_request: "Client request",
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
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "manual";

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
