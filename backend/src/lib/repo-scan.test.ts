import { describe, expect, it, vi } from "vitest";

const { scanRepository } = vi.hoisted(() => ({ scanRepository: vi.fn() }));
vi.mock("./scanners.js", () => ({ scanRepository }));

describe("pull request repository scan evidence", () => {
  it("scans the pinned head SHA without reconciling baseline findings", async () => {
    scanRepository.mockResolvedValueOnce({
      complete: true,
      filesScanned: 7,
      findings: [{ fingerprint: "candidate-finding" }],
      scanners: [{ scanner: "semgrep", version: "1", status: "complete", findings: 1 }],
    });
    const update = vi.fn();
    const supabase = { from: vi.fn(() => ({ update: vi.fn(() => ({ eq: update })) })) } as never;
    const { runPullRequestRepoScan } = await import("./repo-scan.js");

    await expect(runPullRequestRepoScan({
      supabase,
      projectId: "project-1",
      scanId: "scan-1",
      github: { creds: { repo: "owner/repo", token: "secret" } },
      headSha: "a".repeat(40),
    })).resolves.toMatchObject({ commitSha: "a".repeat(40), filesScanned: 7, findingCount: 1 });
    expect(scanRepository).toHaveBeenCalledWith({ repo: "owner/repo", token: "secret" }, "a".repeat(40));
    expect(update).not.toHaveBeenCalled();
  }, 15_000);

  it("refuses incomplete scanner coverage", async () => {
    scanRepository.mockResolvedValueOnce({
      complete: false,
      filesScanned: 0,
      findings: [],
      scanners: [{ scanner: "semgrep", version: "1", status: "failed", findings: 0, reason: "unavailable" }],
    });
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const supabase = { from: vi.fn(() => ({ update })) } as never;
    const { runPullRequestRepoScan } = await import("./repo-scan.js");

    await expect(runPullRequestRepoScan({
      supabase,
      projectId: "project-1",
      scanId: "scan-2",
      github: { creds: { repo: "owner/repo", token: "secret" } },
      headSha: "b".repeat(40),
    })).rejects.toThrow("Pull request scanner coverage was incomplete (semgrep).");
    expect(update).toHaveBeenCalledWith({ scanner_runs: expect.any(Array), scan_complete: false });
  }, 15_000);
});
