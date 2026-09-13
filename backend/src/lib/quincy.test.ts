import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env.js";
import { describeQuincyFallback, parseGithubPrNumber, quincyRemediationPollTimeoutMs, runQuincyRemediationWorkflow } from "./quincy.js";

describe("Quincy PR identity", () => {
  it("accepts only a GitHub PR in the configured repository", () => {
    expect(parseGithubPrNumber("https://github.com/acme/app/pull/12", "acme/app")).toBe(12);
    for (const url of ["https://example.com/acme/app/pull/12", "https://github.com/other/app/pull/12", "https://github.com/acme/app/pull/0", "not-a-url"]) {
      expect(parseGithubPrNumber(url, "acme/app")).toBeNull();
    }
  });
});

describe("runQuincyRemediationWorkflow", () => {
  const originalQuincyUrl = env.QUINCY_API_URL;
  const originalTimeout = env.QUINCY_REMEDIATION_TIMEOUT_MS;

  beforeEach(() => {
    env.QUINCY_API_URL = "http://quincy.local";
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 5_000;
  });

  afterEach(() => {
    env.QUINCY_API_URL = originalQuincyUrl;
    env.QUINCY_REMEDIATION_TIMEOUT_MS = originalTimeout;
    vi.restoreAllMocks();
  });

  it("reconciles a late result without starting a second workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ job_id: "late-job", status: "succeeded", attempts: 3, pr_url: "https://github.com/acme/app/pull/31" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "late-job" });
    expect(result?.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://quincy.local/remediations/late-job/bankai");
  });

  it("checkpoints a running workflow instead of reporting poll expiry as failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ workflow_id: "w", job_id: "slow-job", status_url: "/w" }, { status: 202 }));
    const onStarted = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", onStarted, pollTimeoutMs: 0 });
    expect(onStarted).toHaveBeenCalledWith("slow-job");
    expect(result).toMatchObject({ jobId: "slow-job", status: "running", error: null });
  });

  it("preserves the checkpoint during a temporary status outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "running-job" });
    expect(result).toMatchObject({ jobId: "running-job", status: "running", error: "network unavailable" });
  });

  it("reports completed attempts while the job is still running", async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ job_id: "j", status: "running", attempts: 1, active_attempt: 2, progress_summary: "Generating patch", updated_at: "2026-09-11T06:00:00Z" }))
      .mockResolvedValueOnce(Response.json({ job_id: "j", status: "succeeded", attempts: 2 })));
    await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "CVE-test", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "j", onProgress });
    expect(onProgress).toHaveBeenCalledWith({ summary: "Generating patch", activeAttempt: 2, completedAttempts: 1, updatedAt: "2026-09-11T06:00:00Z" });
  });

  it("requires repository verification before accepting a scanner-backed remediation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(init ? { url, init } : { url });
        if (url === "http://quincy.local/workflows/remediations") {
          return Response.json(
            {
              workflow_id: "workflow-123",
              job_id: "job-456",
              status_url: "/workflows/workflow-123",
            },
            { status: 202 },
          );
        }
        if (url === "http://quincy.local/remediations/job-456/bankai") {
          return Response.json({
            job_id: "job-456",
            status: "succeeded",
            final_status: "succeeded",
            attempts: 1,
            total_cost_usd: 0,
            total_tokens: 10,
            pr_url: "https://github.com/acme/app/pull/7",
            patch: {
              summary: "Validated fix",
              files_changed: 1,
              lines_added: 2,
              lines_removed: 1,
            },
          });
        }
        return Response.json({ detail: "not found" }, { status: 404 });
      }),
    );

    const result = await runQuincyRemediationWorkflow({
      repo: "acme/app",
      ref: "main",
      ruleId: "bandit:B608",
      ticketId: "ticket-1",
      projectId: "project-1",
      severity: "high",
      githubToken: "gh-token",
      baseBranch: "main",
      idempotencyKey: "ticket:ticket-1:quincy-remediation:job:85",
    });

    expect(result).toEqual({
      jobId: "job-456",
      status: "succeeded",
      prUrl: "https://github.com/acme/app/pull/7",
      summary: "Validated fix",
      failureGuidance: null,
      attempts: 1,
      error: null,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://quincy.local/workflows/remediations",
      "http://quincy.local/remediations/job-456/bankai",
    ]);
    const startBody = JSON.parse(String(calls[0]?.init?.body)) as {
      execution_options: {
        require_pov: boolean;
        require_ci_parity: boolean;
        validation_policy: string;
        accept_when_target_finding_removed: boolean;
        ignore_test_command_failures: boolean;
      };
      bankai_context: { idempotency_key: string };
    };
    expect(startBody.execution_options.require_pov).toBe(false);
    expect(startBody.execution_options.require_ci_parity).toBe(true);
    expect(startBody.execution_options.validation_policy).toBe("target_scanner_clean");
    expect(startBody.execution_options.accept_when_target_finding_removed).toBe(true);
    expect(startBody.execution_options.ignore_test_command_failures).toBe(false);
    expect(startBody.bankai_context.idempotency_key).toBe("ticket:ticket-1:quincy-remediation:job:85");
    expect(calls.some((call) => call.url.includes("/remediation/fix"))).toBe(false);
  });

  it("passes precise Bankai finding context to Quincy", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(init ? { url, init } : { url });
        if (url === "http://quincy.local/workflows/remediations") {
          return Response.json({ workflow_id: "workflow-123", job_id: "job-456", status_url: "/workflows/workflow-123" }, { status: 202 });
        }
        return Response.json({ job_id: "job-456", status: "failed", attempts: 3, failure_guidance: "Update pytest only." });
      }),
    );

    const result = await runQuincyRemediationWorkflow({
      repo: "acme/app",
      ref: "main",
      ruleId: "CVE-2025-71176",
      ticketId: "ticket-1",
      projectId: "project-1",
      severity: "high",
      githubToken: "gh-token",
      baseBranch: "main",
      finding: {
        title: "Vulnerable pytest pin",
        filePath: "backend/requirements.txt",
        lineStart: 7,
        lineEnd: 7,
        cwe: "CWE-377",
        affectedPackages: "pytest",
        currentVersions: "7.1.2",
        fixedVersions: "9.0.3",
        description: "pytest is vulnerable.",
        remediationGuidance: "Upgrade pytest.",
      },
    });

    expect(result?.failureGuidance).toBe("Update pytest only.");
    const startBody = JSON.parse(String(calls[0]?.init?.body)) as {
      bankai_context: { finding: { file_path: string; affected_packages: string; fixed_versions: string } };
    };
    expect(startBody.bankai_context.finding).toMatchObject({
      file_path: "backend/requirements.txt",
      affected_packages: "pytest",
      fixed_versions: "9.0.3",
    });
  });

  it("allows Quincy remediation polling to run longer than three minutes", () => {
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 900_000;

    expect(quincyRemediationPollTimeoutMs()).toBe(900_000);
  });

  it("requires executable proof for stored findings without a real scanner rule", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ workflow_id: "workflow-1", job_id: "job-1", status_url: "/workflows/workflow-1" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "failed", attempts: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:finding-1", ticketId: "ticket-1", projectId: "project-1", severity: "high", githubToken: "test-token", baseBranch: "main" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.execution_options).toMatchObject({ require_pov: true, require_ci_parity: true, validation_policy: "full_proof", accept_when_target_finding_removed: false, ignore_test_command_failures: false });
  });

  it("caps Quincy remediation polling at thirty minutes", () => {
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 60 * 60_000;

    expect(quincyRemediationPollTimeoutMs()).toBe(30 * 60_000);
  });

  it("classifies zero-attempt Quincy no-match results as handoff misses instead of validation failures", () => {
    const fallback = describeQuincyFallback({
      jobId: "job-1",
      status: "failed",
      prUrl: null,
      summary: null,
      failureGuidance: null,
      attempts: 0,
      error: "no finding for rule 'CVE-2023-43804' in C:\\workspace",
    });

    expect(fallback.kind).toBe("no_match");
    expect(fallback.logLevel).toBe("info");
    expect(fallback.logMessage).toBe("Quincy could not match finding; continuing to Bankai fallback remediation");
    expect(fallback.note).toContain("Bankai fallback used the ticket's stored finding context.");
  });

  it("keeps attempted Quincy failures classified as validation failures", () => {
    const fallback = describeQuincyFallback({
      jobId: "job-1",
      status: "failed",
      prUrl: null,
      summary: "tests still fail",
      failureGuidance: "Update only the vulnerable package.",
      attempts: 3,
      error: null,
    });

    expect(fallback.kind).toBe("validation_failed");
    expect(fallback.logLevel).toBe("warn");
    expect(fallback.logMessage).toBe("Quincy workflow failed validation; continuing to Bankai fallback remediation");
  });
});
