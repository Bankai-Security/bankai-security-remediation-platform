import { createHash } from "node:crypto";
import { logger } from "./logger.js";

export interface GithubCredentials {
  repo: string; // "owner/repo"
  token: string;
}

export class GithubApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

function githubFetch(creds: GithubCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

export async function getBranchHeadSha(creds: GithubCredentials, branch: string): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (res.status === 404) {
    throw new GithubApiError(`Branch "${branch}" was not found in ${creds.repo}.`, 404);
  }
  if (!res.ok) {
    throw new GithubApiError(`Could not read the branch ref (status ${res.status}).`, res.status);
  }
  const { object } = (await res.json()) as { object: { sha: string } };
  return object.sha;
}

export interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

// One call, recursive — returns every path in the repo at `ref` (a branch
// name or a commit sha) with its blob sha and size, so file filtering can
// happen on this metadata before any file content is downloaded.
export async function getTree(creds: GithubCredentials, ref: string): Promise<GitTreeEntry[]> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (res.status === 404) {
    throw new GithubApiError(`Ref "${ref}" was not found in ${creds.repo}.`, 404);
  }
  if (!res.ok) {
    throw new GithubApiError(`Could not read the repository tree (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { tree: GitTreeEntry[]; truncated?: boolean };
  if (body.truncated) {
    logger.warn({ repo: creds.repo, ref }, "GitHub truncated the tree response — this repo has more files than the API returns in one call");
  }
  return body.tree;
}

export async function getBlob(creds: GithubCredentials, sha: string): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/blobs/${sha}`);
  if (!res.ok) {
    throw new GithubApiError(`Could not read a file blob (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { content: string; encoding: string };
  if (body.encoding !== "base64") {
    throw new GithubApiError(`Unexpected blob encoding "${body.encoding}".`);
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}

export interface FetchableFile {
  path: string;
  sha: string;
}

// Fetches blob content for each file with bounded concurrency, so scanning
// a few hundred files doesn't fire a few hundred simultaneous requests at
// GitHub's REST API. A file that fails to fetch is dropped (logged), not
// fatal to the rest of the scan — mirrors this codebase's best-effort
// philosophy for external calls elsewhere.
export async function getBlobs(
  creds: GithubCredentials,
  files: FetchableFile[],
  concurrency = 5,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index]!;
      try {
        const content = await getBlob(creds, file.sha);
        results.push({ path: file.path, content });
      } catch (err) {
        logger.error({ err, path: file.path }, "Could not fetch a file's contents for scanning — skipping it");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  return results;
}

export interface CompareFileEntry {
  path: string;
  previousPath: string | null;
  sha: string | null; // blob sha at `head`; null for a removed file (no content there)
  status: "added" | "modified" | "removed" | "renamed" | "changed" | "copied";
}

// Used for incremental (webhook-triggered) scans — gives the changed-file
// list directly between two commits, so the worker can skip the full-repo
// tree walk and only re-fetch what actually changed.
export async function compareCommits(creds: GithubCredentials, base: string, head: string): Promise<CompareFileEntry[]> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  if (!res.ok) {
    throw new GithubApiError(`Could not compare commits (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as {
    files?: { filename: string; previous_filename?: string; status: string; sha: string }[];
  };
  return (body.files ?? []).map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    sha: f.status === "removed" ? null : f.sha,
    status: f.status as CompareFileEntry["status"],
  }));
}

export interface RegisteredWebhook {
  id: string;
}

// Best-effort by design (see github.controller.ts's connectGithub): many
// fine-grained PATs don't include the "Webhooks: write" permission, so a
// 403/404 here is the common case, not exceptional — callers must not
// treat it as a connect failure.
export async function registerWebhook(creds: GithubCredentials, input: { url: string; secret: string }): Promise<RegisteredWebhook> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push", "pull_request", "workflow_run"],
      config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" },
    }),
  });

  if (res.status === 403 || res.status === 404) {
    throw new GithubApiError("This token cannot manage webhooks for this repository.", res.status);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(body.message ?? `Could not create the webhook (status ${res.status}).`, res.status);
  }

  const body = (await res.json()) as { id: number };
  return { id: String(body.id) };
}

export async function subscribeWebhookEvents(creds: GithubCredentials, webhookId: string): Promise<void> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/hooks/${encodeURIComponent(webhookId)}`, {
    method: "PATCH",
    body: JSON.stringify({ events: ["push", "pull_request", "workflow_run"] }),
  });
  if (!res.ok) throw new GithubApiError(`Could not update GitHub webhook events (status ${res.status}).`, res.status);
}

// Best-effort — called during disconnect; a failure here must not block
// clearing the project's GitHub connection.
export async function deleteWebhook(creds: GithubCredentials, hookId: string): Promise<void> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new GithubApiError(`Could not remove the webhook (status ${res.status}).`, res.status);
  }
}

// One-off use only, from backend/scripts/backfill-pr-webhooks.ts — updates
// an already-registered webhook's subscribed events (e.g. adding
// "pull_request" to hooks that were registered back when registerWebhook
// only requested "push"). Best-effort, same contract as registerWebhook.

export async function verifyConnection(creds: GithubCredentials): Promise<{ defaultBranch: string }> {
  let res: Response;
  try {
    res = await githubFetch(creds, `/repos/${creds.repo}`);
  } catch {
    throw new GithubApiError("Could not reach GitHub — check your network connection.");
  }
  if (res.status === 401) throw new GithubApiError("Invalid GitHub token.", 401);
  if (res.status === 404) throw new GithubApiError(`Repository "${creds.repo}" was not found, or the token lacks access.`, 404);
  if (!res.ok) throw new GithubApiError(`Could not reach GitHub (status ${res.status}).`, res.status);

  const body = (await res.json()) as { default_branch?: string };
  if (!body.default_branch) throw new GithubApiError("Could not determine the repository's default branch.");
  return { defaultBranch: body.default_branch };
}

// Slugifies a finding title into a short, branch-name-safe segment.
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Deterministic identity segment: two unrelated Bankai accounts creating a
// ticket for the same vulnerability (same fingerprint) on the same repo
// must produce the identical branch name, so createBranch's existing
// 422-idempotency (below) naturally converges them onto one branch instead
// of creating a duplicate. Short hex slice, not the full digest — this is
// a collision-avoidance identifier, not a security boundary.
function fingerprintSlug(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 10);
}

export function buildBranchName(
  fingerprint: string,
  cwe: string | null,
  filePath: string | null,
  scope?: { projectId: string; ticketKey: string } | null,
): string {
  const readable = [cwe, filePath ? filePath.split("/").pop() : null]
    .filter((s): s is string => !!s)
    .map(slug)
    .filter(Boolean)
    .join("-");
  const projectSlug = scope?.projectId ? createHash("sha256").update(scope.projectId).digest("hex").slice(0, 6) : null;
  const ticketSlug = scope?.ticketKey ? slug(scope.ticketKey).slice(0, 18) : null;
  const scopedPrefix = [projectSlug, ticketSlug].filter(Boolean).join("-");
  const identity = [scopedPrefix || null, fingerprintSlug(fingerprint)].filter(Boolean).join("-");
  return `remediation/${identity}${readable ? `-${readable}` : ""}`;
}

// Never throws — same best-effort contract as jira.ts's deleteIssue. A 404
// counts as success (already gone either way, e.g. merged/deleted manually).
// branchName is NOT URL-encoded as a whole: buildBranchName's output
// ("remediation/<key>-<slug>") contains an intentional "/" that must stay
// literal in the path, and every character it can contain is already
// URL-safe (lowercase alphanumerics and hyphens only).
export async function deleteBranch(creds: GithubCredentials, branchName: string): Promise<boolean> {
  try {
    const res = await githubFetch(creds, `/repos/${creds.repo}/git/refs/heads/${branchName}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export interface CreatedBranch {
  name: string;
  url: string;
}

// Idempotent: if the branch already exists (422 "Reference already exists"),
// this returns the existing branch instead of throwing — a ticket's branch
// creation may be retried (e.g. via syncTickets) without producing an error.
// Since buildBranchName derives the name from the vulnerability's own
// fingerprint rather than any account-local ticket key, this idempotency
// also naturally covers two unrelated Bankai accounts creating a ticket for
// the same vulnerability on the same repo — the second call resolves to the
// first account's branch instead of creating a duplicate.
export async function createBranch(
  creds: GithubCredentials,
  input: { baseBranch: string; branchName: string },
): Promise<CreatedBranch> {
  let baseSha: string;
  try {
    baseSha = await getBranchHeadSha(creds, input.baseBranch);
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) {
      throw new GithubApiError(`Base branch "${input.baseBranch}" was not found in ${creds.repo}.`, 404);
    }
    throw err;
  }

  const createRes = await githubFetch(creds, `/repos/${creds.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: baseSha }),
  });

  if (createRes.ok) {
    return { name: input.branchName, url: `https://github.com/${creds.repo}/tree/${input.branchName}` };
  }

  if (createRes.status === 422) {
    const body = (await createRes.json().catch(() => ({}))) as { message?: string };
    if (body.message?.includes("Reference already exists")) {
      return { name: input.branchName, url: `https://github.com/${creds.repo}/tree/${input.branchName}` };
    }
  }

  if (createRes.status === 403) {
    throw new GithubApiError(
      "GitHub token lacks write access to create branches. Use a fine-grained token with " +
        `"Contents: Read and write" for ${creds.repo}, or a classic token with the "repo" scope.`,
      403,
    );
  }

  const body = (await createRes.json().catch(() => ({}))) as { message?: string };
  throw new GithubApiError(body.message ?? `Branch creation failed (status ${createRes.status}).`, createRes.status);
}

// --- Git Data API: committing an AI-generated fix onto an existing branch ---
// No Contents API here on purpose — commitFileToBranch below needs a single
// commit built from an explicit parent sha (so updateBranchRef's force:false
// fast-forward check means something), which the Git Data API's
// tree/commit/ref primitives give directly; the Contents API's "one PUT per
// file" shape doesn't expose that control.

export async function getCommit(creds: GithubCredentials, sha: string): Promise<{ treeSha: string; parentShas: string[] }> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/commits/${sha}`);
  if (!res.ok) {
    throw new GithubApiError(`Could not read commit ${sha} (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { tree: { sha: string }; parents?: Array<{ sha: string }> };
  return { treeSha: body.tree.sha, parentShas: (body.parents ?? []).map((parent) => parent.sha) };
}

/** Return the exact patch GitHub serves for an immutable base/candidate pair. */
export async function getCommitDiff(creds: GithubCredentials, baseSha: string, candidateSha: string): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/compare/${baseSha}...${candidateSha}`, {
    headers: { Accept: "application/vnd.github.diff" },
  });
  if (!res.ok) throw new GithubApiError(`Could not read the generated commit diff (status ${res.status}).`, res.status);
  const diff = await res.text();
  if (!diff.trim()) throw new GithubApiError("GitHub returned an empty diff for the generated candidate.");
  return diff;
}

export interface TreeContentEntry {
  path: string;
  content: string;
}

// Inline `content` on each tree entry — GitHub creates the underlying blob
// itself, so this is one call instead of "create a blob per file, then
// create a tree referencing their shas".
export async function createTree(
  creds: GithubCredentials,
  baseTreeSha: string,
  entries: TreeContentEntry[],
): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", content: e.content })),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(body.message ?? `Could not create a tree (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { sha: string };
  return body.sha;
}

export async function createCommit(
  creds: GithubCredentials,
  input: { message: string; treeSha: string; parentSha: string },
): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: input.message, tree: input.treeSha, parents: [input.parentSha] }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(body.message ?? `Could not create a commit (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { sha: string };
  return body.sha;
}

// force:false is deliberate: if the branch has moved since `sha`'s parent
// was read (e.g. a human pushed a commit in the race window between the
// fix-pr job reading the branch head and committing), this update is not a
// fast-forward and GitHub responds 422 — surfaced as GithubApiError so the
// caller records it as a failure instead of silently overwriting the
// human's commit.
export async function updateBranchRef(creds: GithubCredentials, branch: string, sha: string): Promise<void> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha, force: false }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(body.message ?? `Could not update branch "${branch}" (status ${res.status}).`, res.status);
  }
}

export interface CommittedFix {
  commitSha: string;
}

// Composes Git Data API calls into one commit that changes one or more files.
// Not idempotent by itself — callers that may re-run (the fix-pr job) are expected
// to check ticket.github_fix_commit_sha against the branch's current head sha first.
export async function commitFileToBranch(
  creds: GithubCredentials,
  input: { branch: string; baseSha: string; message: string; files: TreeContentEntry[] },
): Promise<CommittedFix> {
  if (input.files.length === 0) {
    throw new Error("commitFileToBranch called with no files.");
  }
  const { treeSha: baseTreeSha } = await getCommit(creds, input.baseSha);
  const treeSha = await createTree(creds, baseTreeSha, input.files);
  const commitSha = await createCommit(creds, { message: input.message, treeSha, parentSha: input.baseSha });
  await updateBranchRef(creds, input.branch, commitSha);
  return { commitSha };
}

export interface CreatedPullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  headRef: string | null;
  headSha: string | null;
  // GitHub's own distinction: a PR's `state` becomes "closed" both when
  // merged and when closed unmerged — `merged` is the only field that tells
  // those apart. Always false for createPullRequest (a PR is never merged
  // the instant it's created), meaningful for lookups after a 422.
  merged: boolean;
}

interface GithubPullRequestApiBody {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  head?: { ref?: string; sha?: string };
}

function toCreatedPullRequest(body: GithubPullRequestApiBody): CreatedPullRequest {
  return {
    number: body.number,
    url: body.html_url,
    state: body.state === "closed" ? "closed" : "open",
    headRef: body.head?.ref ?? null,
    headSha: body.head?.sha ?? null,
    merged: body.merged ?? false,
  };
}

// Idempotent like createBranch: GitHub 422s "A pull request already exists
// for {owner}:{head}." if one is already open for this head/base pair — that
// case looks the existing PR up and returns it instead of throwing, so a
// re-run of the fix-pr job (or two projects racing on the same branch) never
// produces a duplicate PR.
export async function createPullRequest(
  creds: GithubCredentials,
  input: { head: string; base: string; title: string; body: string },
): Promise<CreatedPullRequest> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body }),
  });

  if (res.ok) {
    return toCreatedPullRequest((await res.json()) as GithubPullRequestApiBody);
  }

  if (res.status === 422) {
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
      errors?: { message?: string; resource?: string; field?: string; code?: string }[];
    };
    const owner = creds.repo.split("/")[0];
    const existingRes = await githubFetch(
      creds,
      `/repos/${creds.repo}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&state=all`,
    ).catch(() => null);
    if (existingRes?.ok) {
      const existing = (await existingRes.json()) as GithubPullRequestApiBody[];
      const open = existing.find((pr) => pr.state === "open");
      if (open) return toCreatedPullRequest(open);

      // A closed PR cannot be returned as if it were a newly opened one. Keep
      // GitHub's original validation response and attach the prior PR state so
      // callers can resolve stale branch state explicitly.
      if (existing[0]) {
        const prior = existing[0];
        const state = prior.merged ? "merged" : "closed";
        const errors = errBody.errors?.map((e) => e.message || [e.resource, e.field, e.code].filter(Boolean).join(" ")).filter(Boolean);
        const detail = [errBody.message, ...(errors ?? [])].filter(Boolean).join(": ");
        throw new GithubApiError(`GitHub rejected the pull request because prior PR #${prior.number} for this branch is ${state}${detail ? ` (${detail})` : ""}.`, 422);
      }
    }

    const errors = errBody.errors?.map((e) => e.message || [e.resource, e.field, e.code].filter(Boolean).join(" ")).filter(Boolean);
    const detail = [errBody.message, ...(errors ?? [])].filter(Boolean).join(": ");
    throw new GithubApiError(detail || "GitHub rejected the pull request because its head or base branch is invalid (status 422).", 422);
  }

  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new GithubApiError(body.message ?? `Could not open a pull request (status ${res.status}).`, res.status);
}

// Not on the webhook-driven merge-detection path — used by the manual
// "Sync with GitHub" fallback (ticket.controller.ts's syncGithubPrStatuses)
// for setups where GitHub can't reach this backend's webhook endpoint (e.g.
// local dev with no publicly reachable BACKEND_PUBLIC_URL).
export async function getPullRequest(creds: GithubCredentials, prNumber: number): Promise<CreatedPullRequest | null> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/pulls/${prNumber}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GithubApiError(`Could not read pull request #${prNumber} (status ${res.status}).`, res.status);
  }
  return toCreatedPullRequest((await res.json()) as GithubPullRequestApiBody);
}

const JENKINS_EVIDENCE_MARKER = "<!-- bankai-jenkins-evidence -->";
const PR_SCAN_EVIDENCE_MARKER = "<!-- bankai-pr-scan-evidence -->";
const HOSTED_CI_EVIDENCE_MARKER = "<!-- bankai-hosted-ci-evidence -->";

/** Keep one Bankai evidence comment per pull request and update it as CD progresses. */
export async function upsertJenkinsEvidenceComment(creds: GithubCredentials, prNumber: number, markdown: string): Promise<string> {
  return upsertBankaiComment(creds, prNumber, markdown, JENKINS_EVIDENCE_MARKER);
}

export async function upsertPullRequestScanEvidenceComment(creds: GithubCredentials, prNumber: number, markdown: string): Promise<string> {
  return upsertBankaiComment(creds, prNumber, markdown, PR_SCAN_EVIDENCE_MARKER);
}

export async function upsertHostedCiEvidenceComment(creds: GithubCredentials, prNumber: number, markdown: string): Promise<string> {
  return upsertBankaiComment(creds, prNumber, markdown, HOSTED_CI_EVIDENCE_MARKER);
}

async function upsertBankaiComment(creds: GithubCredentials, prNumber: number, markdown: string, marker: string): Promise<string> {
  const userResponse = await githubFetch(creds, "/user");
  if (!userResponse.ok) throw new GithubApiError(`Could not identify the connected GitHub account (status ${userResponse.status}).`, userResponse.status);
  const user = await userResponse.json() as { login?: string };
  if (!user.login) throw new GithubApiError("GitHub did not return the connected account name.");

  for (let page = 1; page <= 5; page += 1) {
    const response = await githubFetch(creds, `/repos/${creds.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!response.ok) throw new GithubApiError(`Could not read pull request comments (status ${response.status}).`, response.status);
    const comments = await response.json() as Array<{ id: number; body?: string; user?: { login?: string } }>;
    const existing = comments.find((comment) => comment.user?.login === user.login && comment.body?.includes(marker));
    if (existing) {
      const update = await githubFetch(creds, `/repos/${creds.repo}/issues/comments/${existing.id}`, {
        method: "PATCH", body: JSON.stringify({ body: `${marker}\n${markdown}` }),
      });
      if (!update.ok) throw new GithubApiError(`Could not update the pull request evidence comment (status ${update.status}).`, update.status);
      const result = await update.json() as { html_url?: string };
      return result.html_url ?? `https://github.com/${creds.repo}/pull/${prNumber}`;
    }
    if (comments.length < 100) break;
  }

  const created = await githubFetch(creds, `/repos/${creds.repo}/issues/${prNumber}/comments`, {
    method: "POST", body: JSON.stringify({ body: `${marker}\n${markdown}` }),
  });
  if (!created.ok) throw new GithubApiError(`Could not attach evidence to the pull request (status ${created.status}).`, created.status);
  const result = await created.json() as { html_url?: string };
  return result.html_url ?? `https://github.com/${creds.repo}/pull/${prNumber}`;
}

export async function updatePullRequestBranchFile(
  creds: GithubCredentials,
  input: { pullRequestNumber: number; branchName: string; filePath: string; content: string; message: string },
): Promise<string> {
  const pullRequest = await getPullRequest(creds, input.pullRequestNumber);
  if (!pullRequest || pullRequest.state !== "open" || pullRequest.headRef !== input.branchName) {
    throw new GithubApiError(`Pull request #${input.pullRequestNumber} is no longer open on the expected branch.`, 409);
  }
  const headSha = await getBranchHeadSha(creds, input.branchName);
  return (await commitFileToBranch(creds, {
    branch: input.branchName,
    baseSha: headSha,
    message: input.message,
    files: [{ path: input.filePath, content: input.content }],
  })).commitSha;
}

// Deliberately not implemented: merging a pull request. Merging stays a
// human-only action performed on GitHub itself — Bankai commits the fix and
// opens the PR, but never clicks merge.
