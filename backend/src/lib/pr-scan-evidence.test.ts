import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertPullRequestScanEvidenceComment, loadGithubCreds, maybeSingle } = vi.hoisted(() => ({
  upsertPullRequestScanEvidenceComment: vi.fn(),
  loadGithubCreds: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("./github.js", () => ({ upsertPullRequestScanEvidenceComment }));
vi.mock("./ticketing.js", () => ({ loadGithubCreds }));
vi.mock("./supabase.js", () => ({ supabaseAdmin: { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) })) } }));

describe("pull request scan evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingle.mockResolvedValue({ data: {
      scan_type: "pull_request",
      pull_request_number: 42,
      commit_sha: "a".repeat(40),
      status: "Done",
      scan_complete: true,
      finding_count: 3,
      scanner_runs: [{ scanner: "semgrep", status: "complete" }],
    }, error: null });
    loadGithubCreds.mockResolvedValue({ creds: { repo: "owner/repo", token: "top-secret-token" } });
  });

  it("publishes exact-SHA scan status without leaking credentials", async () => {
    const { publishPullRequestScanEvidence } = await import("./pr-scan-evidence.js");
    await publishPullRequestScanEvidence("project-1", "scan-1");

    expect(upsertPullRequestScanEvidenceComment).toHaveBeenCalledOnce();
    const [, prNumber, comment] = upsertPullRequestScanEvidenceComment.mock.calls[0]!;
    expect(prNumber).toBe(42);
    expect(comment).toContain("Passed");
    expect(comment).toContain("a".repeat(40));
    expect(comment).toContain("not added to baseline triage");
    expect(comment).not.toContain("top-secret-token");
  });

  it("skips non-PR scans", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { scan_type: "baseline" }, error: null });
    const { publishPullRequestScanEvidence } = await import("./pr-scan-evidence.js");
    await publishPullRequestScanEvidence("project-1", "scan-2");
    expect(upsertPullRequestScanEvidenceComment).not.toHaveBeenCalled();
  });
});
