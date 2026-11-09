import { isStepFinished, type DomainStatus, type StepStatus } from "@/lib/status";

/**
 * A replacement's new domain that hasn't started its warm-up yet: its inboxes
 * are still being set up at Hypertide or haven't all reached Smartlead. These
 * show on Smartlead → Warming up under "Setting up", so every new domain is
 * there from the day it's picked, not only once its inboxes sync.
 */
export type SetupRow = {
  domainId: string; domain: string; status: DomainStatus; clientName: string | null; clientHue: number | null;
  oldDomain: string; tags: string[];
  stepNameservers: StepStatus; stepInboxes: StepStatus; stepSmartlead: StepStatus;
  htOperation: string | null; lastError: string | null;
  /** Connected inboxes in Smartlead now, and how many the old domain had. */
  inboxes: number; expected: number;
  dnsSpf: boolean | null; dnsDkim: boolean | null; dnsDmarc: boolean | null; dnsMx: boolean | null; nsAnswering: boolean | null;
  startedAt: string;
};

/** Where a setting-up domain is, in a few words. */
export function setupLabel(s: SetupRow): { text: string; attention: boolean } {
  const failed = (st: StepStatus) => st === "failed" || st === "manual";
  if (!isStepFinished(s.stepNameservers)) {
    return failed(s.stepNameservers) ? { text: "Nameservers need you", attention: true } : { text: "Setting nameservers", attention: false };
  }
  if (!isStepFinished(s.stepInboxes)) {
    if (failed(s.stepInboxes)) return { text: "Inboxes need you", attention: true };
    return { text: s.htOperation === "completed" ? "Hypertide creating inboxes" : "Inboxes being ordered", attention: false };
  }
  if (!isStepFinished(s.stepSmartlead)) {
    return { text: s.inboxes ? `In Smartlead: ${s.inboxes} of ${s.expected || "?"}` : "Waiting for Smartlead", attention: false };
  }
  return { text: "Waiting for DNS", attention: false };
}
