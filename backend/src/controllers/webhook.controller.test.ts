import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueRepoScan, getPullRequest, loadGithubCreds, scans, tickets, pipelineRuns, project } = vi.hoisted(() => ({
  enqueueRepoScan: vi.fn(),
  getPullRequest: vi.fn(async () => ({ state: "open", headRef: "remediation/fix", headSha: "b".repeat(40) })),
  loadGithubCreds: vi.fn(async () => ({ creds: { repo: "owner/repo", token: "test" }, defaultBranch: "main" })),
  scans: new Map<string, { id: string }>(),
  tickets: new Map<string, Record<string, unknown>>(),
  pipelineRuns: [] as Record<string, unknown>[],
  project: {
    github_repo: "owner/repo",
    github_default_branch: "main",
    github_webhook_secret_enc: "encrypted",
    github_connected_at: "2026-11-21T00:00:00.000Z",
    verification_provider: null as string | null,
  },
}));

vi.mock("../lib/crypto.js", () => ({ decrypt: () => "test-hook-secret" }));
vi.mock("../lib/queue.js", () => ({ enqueueRepoScan }));
vi.mock("../lib/github.js", () => ({ getPullRequest, upsertHostedCiEvidenceComment: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/ticketing.js", () => ({ loadGithubCreds, markTicketPrClosedWithoutMerge: vi.fn(), markTicketPrMerged: vi.fn() }));
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "projects") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: project, error: null }) }) }) };
      if (table === "tickets" || table === "pipeline_runs") {
        let operation = "select";
        let values: Record<string, unknown> = {};
        const filters: Array<[string, unknown]> = [];
        const builder: Record<string, unknown> = {
          select: () => builder,
          update: (next: Record<string, unknown>) => { operation = "update"; values = next; return builder; },
          upsert: (next: Record<string, unknown>) => { operation = "upsert"; values = next; return builder; },
          eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
          is: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
          neq: () => builder,
          in: () => builder,
          maybeSingle: async () => {
            const matches = (row: Record<string, unknown>) => filters.every(([column, value]) => row[column] === value);
            if (table === "tickets") {
              const row = [...tickets.values()].find(matches);
              if (!row) return { data: null, error: null };
              if (operation === "update") Object.assign(row, values);
              return { data: { ...row }, error: null };
            }
            const row = pipelineRuns.find(matches);
            if (!row) return { data: null, error: null };
            if (operation === "update") Object.assign(row, values);
            return { data: { ...row }, error: null };
          },
          then: (resolve: (value: unknown) => unknown) => {
            if (table === "pipeline_runs" && operation === "upsert"
              && !pipelineRuns.some((row) => row.ticket_id === values.ticket_id && row.commit_sha === values.commit_sha)) pipelineRuns.push(values);
            if (table === "tickets" && operation === "update") {
              for (const row of tickets.values()) if (filters.every(([column, value]) => row[column] === value)) Object.assign(row, values);
            }
            if (table === "pipeline_runs" && operation === "update") {
              for (const row of pipelineRuns) if (filters.every(([column, value]) => row[column] === value)) Object.assign(row, values);
            }
            return resolve({ data: null, error: null });
          },
        };
        return builder;
      }
      return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({ maybeSingle: async () => {
              const key = `${row.project_id}:${row.event_key}`;
              if (scans.has(key)) return { data: null, error: { code: "23505" } };
              const value = { id: `scan-${scans.size + 1}` };
              scans.set(key, value);
              return { data: value, error: null };
            } }),
          }),
          select: () => ({ eq: (_column: string, projectId: string) => ({ eq: (_eventColumn: string, eventKey: string) => ({ maybeSingle: async () => ({ data: scans.get(`${projectId}:${eventKey}`) ?? null, error: null }) }) }) }),
      };
    },
  },
}));

describe("GitHub pull request webhook scans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scans.clear();
    tickets.clear();
    pipelineRuns.length = 0;
    project.verification_provider = null;
    getPullRequest.mockClear();
    loadGithubCreds.mockClear();
  });

  it("queues exact-SHA PR scans idempotently without merging them into baseline", async () => {
    const { handleGithubWebhook } = await import("./webhook.controller.js");
    const payload = Buffer.from(JSON.stringify({
      action: "synchronize",
      number: 17,
      pull_request: {
        head: { sha: "a".repeat(40), ref: "remediation/fix", repo: { full_name: "fork/repo" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "OWNER/REPO" } },
      },
    }));
    const signature = `sha256=${createHmac("sha256", "test-hook-secret").update(payload).digest("hex")}`;
    const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() });
    const invoke = async () => {
      const res = response();
      await handleGithubWebhook({
        params: { projectId: "project-1" },
        body: payload,
        get: (header: string) => ({
          "x-hub-signature-256": signature,
          "x-github-event": "pull_request",
        })[header.toLowerCase()],
      } as never, res as never);
      return res;
    };

    const first = await invoke();
    const duplicate = await invoke();

    expect(first.status).toHaveBeenCalledWith(202);
    expect(duplicate.status).toHaveBeenCalledWith(202);
    expect(scans.size).toBe(1);
    expect(enqueueRepoScan).toHaveBeenCalledTimes(2);
    expect(enqueueRepoScan).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scanType: "pull_request",
      pullRequestNumber: 17,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      headRepo: "fork/repo",
    }), `pr-project-1-17-${"a".repeat(40)}`);
    expect(enqueueRepoScan.mock.calls[0]).toEqual(enqueueRepoScan.mock.calls[1]);
  });

  it("advances Jenkins verification to the latest synchronized PR commit", async () => {
    project.verification_provider = "jenkins";
    tickets.set("ticket-1", { id: "ticket-1", project_id: "project-1", github_pr_number: 17, github_pr_state: "open",
      github_branch_name: "remediation/fix", github_fix_commit_sha: "a".repeat(40), ci_status: "needs_review" });
    const { handleGithubWebhook } = await import("./webhook.controller.js");
    const payload = Buffer.from(JSON.stringify({ action: "synchronize", number: 17, pull_request: {
      head: { sha: "c".repeat(40), ref: "remediation/fix", repo: { full_name: "owner/repo" } },
      base: { sha: "d".repeat(40), ref: "main", repo: { full_name: "owner/repo" } },
    } }));
    const signature = `sha256=${createHmac("sha256", "test-hook-secret").update(payload).digest("hex")}`;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() };
    await handleGithubWebhook({ params: { projectId: "project-1" }, body: payload,
      get: (header: string) => ({ "x-hub-signature-256": signature, "x-github-event": "pull_request" })[header.toLowerCase()],
    } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(tickets.get("ticket-1")).toMatchObject({ github_fix_commit_sha: "b".repeat(40), ci_status: "queued", ci_error: null, ci_run_url: null });
    expect(pipelineRuns).toContainEqual(expect.objectContaining({ ticket_id: "ticket-1", commit_sha: "b".repeat(40), status: "queued" }));
  });
});
