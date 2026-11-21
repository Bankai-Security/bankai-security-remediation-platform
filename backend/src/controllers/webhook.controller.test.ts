import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueRepoScan, scans, project } = vi.hoisted(() => ({
  enqueueRepoScan: vi.fn(),
  scans: new Map<string, { id: string }>(),
  project: {
    github_repo: "owner/repo",
    github_default_branch: "main",
    github_webhook_secret_enc: "encrypted",
    github_connected_at: "2026-11-21T00:00:00.000Z",
  },
}));

vi.mock("../lib/crypto.js", () => ({ decrypt: () => "test-hook-secret" }));
vi.mock("../lib/queue.js", () => ({ enqueueRepoScan }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/ticketing.js", () => ({ markTicketPrClosedWithoutMerge: vi.fn(), markTicketPrMerged: vi.fn() }));
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: {
    from: (table: string) => table === "projects"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: project, error: null }) }) }) }
      : {
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
        },
  },
}));

describe("GitHub pull request webhook scans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scans.clear();
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
});
