import { expect, it } from "vitest";
import { reconciledTicketStatus, statusAllowedByCompletionGate } from "./ticket-status-sync.js";

it("repairs TT2-65's To Do status when its PR is open", () => {
  expect(reconciledTicketStatus("To Do", "To Do", true)).toBe("In Review");
  expect(reconciledTicketStatus("In Review", "To Do", true)).toBe("In Review");
});
it("preserves completed tickets and never closes tickets from Jira alone", () => {
  expect(reconciledTicketStatus("Done", "To Do", false, { githubPrState: "merged", ciStatus: "passed" })).toBe("Done");
  expect(reconciledTicketStatus("In Review", "Done", true)).toBe("In Review");
  expect(reconciledTicketStatus("In Progress", "Done", false)).toBe("In Progress");
});
it("repairs a ticket that jumped to Done before its remediation completed", () => {
  expect(statusAllowedByCompletionGate("Done", { githubBranchName: "bankai/TT2-68", githubPrNumber: null })).toBe("In Progress");
  expect(reconciledTicketStatus("Done", "To Do", false, { githubBranchName: "bankai/TT2-68" })).toBe("In Progress");
  expect(statusAllowedByCompletionGate("Done", { githubPrNumber: 30, githubPrState: "open", ciStatus: "passed" })).toBe("In Review");
  expect(statusAllowedByCompletionGate("Done", { githubPrNumber: 30, githubPrState: "merged", ciStatus: "failed" })).toBe("In Review");
  expect(statusAllowedByCompletionGate("Done", { githubPrNumber: 30, githubPrState: "merged", ciStatus: "passed" })).toBe("Done");
});
it("still imports manual Jira changes without an open PR", () => {
  expect(reconciledTicketStatus("To Do", "In Progress", false)).toBe("In Progress");
  expect(reconciledTicketStatus("In Review", null, false)).toBe("In Review");
});
