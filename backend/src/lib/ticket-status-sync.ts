import type { TicketStatus } from "./pipeline-types.js";

export interface TicketCompletionEvidence {
  githubBranchName?: string | null;
  githubPrNumber?: number | null;
  githubPrState?: string | null;
  ciStatus?: string | null;
  collateralResolutionEventId?: string | null;
}

export function statusAllowedByCompletionGate(
  current: TicketStatus,
  evidence: TicketCompletionEvidence,
): TicketStatus {
  if (current !== "Done") return current;
  if (evidence.githubPrState === "merged" && evidence.ciStatus === "passed") return "Done";
  if (evidence.collateralResolutionEventId) return "Done";
  return evidence.githubPrNumber != null ? "In Review" : "In Progress";
}

export function reconciledTicketStatus(
  current: TicketStatus,
  jira: TicketStatus | null,
  hasOpenPr: boolean,
  evidence: TicketCompletionEvidence = {},
): TicketStatus {
  // Completion comes from resolution/merge handlers, never a Jira pull.
  const gatedCurrent = statusAllowedByCompletionGate(current, evidence);
  if (current === "Done") return gatedCurrent;
  if (hasOpenPr) return "In Review";
  return jira && jira !== "Done" ? jira : gatedCurrent;
}
