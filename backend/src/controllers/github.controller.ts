import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { recordActivity } from "../lib/activity.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { commitFileToBranch, createBranch, createPullRequest, deleteBranch, deleteWebhook, getBlob, getBlobs, getBranchHeadSha, getTree, GithubApiError, registerWebhook, updatePullRequestBranchFile, verifyConnection, type GithubCredentials, type GitTreeEntry } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { buildJenkinsfile, generatePipelinePlan, validateJenkinsfile, type PipelineCommand, type PipelineStage } from "../lib/jenkinsfile-generator.js";
import { logger } from "../lib/logger.js";
import { enqueueRepoScan } from "../lib/queue.js";
import { requireRole } from "../lib/roles.js";
import { SCAN_SELECT, toPublicScan, type ScanRow } from "../lib/scans.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { loadGithubCreds } from "../lib/ticketing.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { ConnectGithubFromAccountInput, ConnectGithubInput } from "../schemas/github.schema.js";
import type { AcceptJenkinsfileProposalInput, UpdateJenkinsfilePullRequestInput } from "../schemas/jenkinsfile.schema.js";

const JENKINSFILE_PATH = "Jenkinsfile";
const MAX_JENKINSFILE_CONTEXT_BYTES = 75_000;

interface JenkinsfileRepoContext {
  creds: GithubCredentials;
  branch: string;
  headSha: string;
  tree: GitTreeEntry[];
}

async function loadJenkinsfileContext(req: Request): Promise<JenkinsfileRepoContext> {
  const github = await loadGithubCreds(userScopedClient(req), req.project!.id);
  if (!github) throw new HttpError(422, "Connect GitHub to this project before setting up its Jenkinsfile.");
  try {
    const headSha = await getBranchHeadSha(github.creds, github.defaultBranch);
    const tree = await getTree(github.creds, headSha);
    return { creds: github.creds, branch: github.defaultBranch, headSha, tree };
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : "Could not inspect this repository on GitHub.");
  }
}

function findRootJenkinsfile(tree: GitTreeEntry[]): GitTreeEntry | undefined {
  return tree.find((entry) => entry.type === "blob" && entry.path === JENKINSFILE_PATH);
}

function isJenkinsContextFile(path: string): boolean {
  const name = path.split("/").pop()!.toLowerCase();
  return path.startsWith(".github/workflows/") || [
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
    "requirements.txt", "pyproject.toml", "pipfile", "setup.cfg", "pom.xml", "build.gradle", "build.gradle.kts",
    "mvnw", "gradlew", "go.mod", "cargo.toml", "makefile", "composer.json", "gemfile", "dockerfile",
  ].includes(name) || name.endsWith(".sln") || name.endsWith(".csproj");
}

async function fetchJenkinsContextFiles(creds: GithubCredentials, tree: GitTreeEntry[]): Promise<Array<{ path: string; content: string }>> {
  const entries = tree
    .filter((entry) => entry.type === "blob" && entry.size !== 0 && isJenkinsContextFile(entry.path) && (entry.size ?? 0) <= 20_000)
    .sort((a, b) => {
      const score = (path: string) => path.startsWith(".github/workflows/") ? 3 : path.split("/").length === 1 ? 0 : 1;
      return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
    })
    .slice(0, 24);
  const fetched = await getBlobs(creds, entries.map(({ path, sha }) => ({ path, sha })), 5);
  let bytes = 0;
  const result: Array<{ path: string; content: string }> = [];
  for (const file of fetched) {
    if (bytes + file.content.length > MAX_JENKINSFILE_CONTEXT_BYTES) continue;
    result.push(file);
    bytes += file.content.length;
  }
  return result;
}

function discoverPipelineCommands(tree: GitTreeEntry[], files: Array<{ path: string; content: string }>): Array<PipelineCommand & { evidence: string }> {
  const paths = new Set(tree.map((entry) => entry.path));
  const contentByPath = new Map(files.map((file) => [file.path, file.content]));
  const commands = new Map<string, PipelineCommand & { evidence: string }>();
  const add = (stage: PipelineStage, command: string, evidence: string) => commands.set(command, { stage, command, evidence });
  for (const file of files.filter((candidate) => candidate.path.split("/").pop() === "package.json")) {
    let packageJson: { scripts?: Record<string, string>; packageManager?: string };
    try { packageJson = JSON.parse(file.content) as typeof packageJson; } catch { continue; }
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    if (!/^[\w./-]*$/.test(dir) || dir.split("/").includes("..")) continue;
    const prefix = dir ? `--prefix ${dir}` : "";
    const lockPath = (name: string) => dir ? `${dir}/${name}` : name;
    if (paths.has(lockPath("package-lock.json"))) add("Install", `npm ${prefix} ci`.replace(/\s+/g, " ").trim(), file.path + " + package-lock.json");
    else if (paths.has(lockPath("pnpm-lock.yaml"))) add("Install", `pnpm --dir ${dir || "."} install --frozen-lockfile`, file.path + " + pnpm-lock.yaml");
    else if (paths.has(lockPath("yarn.lock"))) add("Install", `yarn --cwd ${dir || "."} install --frozen-lockfile`, file.path + " + yarn.lock");
    else if (paths.has(lockPath("bun.lock")) || paths.has(lockPath("bun.lockb"))) add("Install", `bun --cwd ${dir || "."} install --frozen-lockfile`, file.path + " + bun.lock");
    for (const name of Object.keys(packageJson.scripts ?? {}).sort()) {
      const stage = /^(build|compile|typecheck)$/i.test(name) ? "Build" : /^(test|lint|check|verify)$/i.test(name) ? "Test" : null;
      if (!stage) continue;
      const command = `npm ${prefix} run ${name}`.replace(/\s+/g, " ").trim();
      add(stage, command, `${file.path} scripts.${name}`);
    }
  }
  if (contentByPath.has("requirements.txt")) {
    add("Install", "python -m pip install -r requirements.txt", "requirements.txt");
    const reqs = contentByPath.get("requirements.txt")!.toLowerCase();
    if (reqs.includes("pytest")) add("Test", "python -m pytest", "requirements.txt includes pytest");
  }
  const pyproject = contentByPath.get("pyproject.toml")?.toLowerCase() ?? "";
  if (pyproject.includes("pytest")) add("Test", "python -m pytest", "pyproject.toml configures pytest");
  if (paths.has("go.mod")) { add("Build", "go build ./...", "go.mod"); add("Test", "go test ./...", "go.mod"); }
  if (paths.has("Cargo.toml")) { add("Build", "cargo build --workspace", "Cargo.toml"); add("Test", "cargo test --workspace", "Cargo.toml"); }
  if (paths.has("pom.xml")) add("Test", paths.has("mvnw") ? "./mvnw -B test" : "mvn -B test", paths.has("mvnw") ? "pom.xml + mvnw" : "pom.xml");
  if (paths.has("build.gradle") || paths.has("build.gradle.kts")) add("Test", paths.has("gradlew") ? "./gradlew test" : "gradle test", paths.has("gradlew") ? "Gradle build file + wrapper" : "Gradle build file");
  if (paths.has("Makefile")) {
    const makefile = contentByPath.get("Makefile") ?? "";
    for (const target of ["build", "test", "check", "lint"]) {
      if (new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(makefile)) add(target === "build" ? "Build" : "Test", `make ${target}`, `Makefile target ${target}`);
    }
  }
  return Array.from(commands.values());
}

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface GithubConnectionRow {
  github_repo: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
  github_webhook_registered_at: string | null;
}

function toPublicConnection(row: GithubConnectionRow, projectId: string) {
  return {
    connected: row.github_connected_at !== null,
    repo: row.github_repo,
    defaultBranch: row.github_default_branch,
    connectedAt: row.github_connected_at,
    webhookRegistered: row.github_webhook_registered_at !== null,
    // Present even when auto-registration hasn't happened, so the frontend
    // can always show "point GitHub here" in a manual-setup banner — this
    // is a deterministic function of BACKEND_PUBLIC_URL + the project id,
    // not something that needs a DB round trip to know.
    webhookUrl: env.BACKEND_PUBLIC_URL ? `${env.BACKEND_PUBLIC_URL}/api/webhooks/github/${projectId}` : null,
  };
}

const GITHUB_CONNECTION_SELECT = "github_repo, github_default_branch, github_connected_at, github_webhook_registered_at";

export async function getGithubStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select(GITHUB_CONNECTION_SELECT)
    .eq("id", req.project!.id)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not load this project's GitHub connection.");
  }

  res.status(200).json(toPublicConnection(data as GithubConnectionRow, req.project!.id));
}

// The verify -> best-effort webhook register -> persist -> activity-log
// core, shared by both ways a project can get connected: connectGithub
// (manual PAT, below) and connectGithubFromAccount (repo picker, using a
// token from the caller's account-level GitHub OAuth connection instead of
// one typed into the request). Neither caller needs to know how the other
// obtains its token — this function just takes one.
async function persistGithubConnection(input: {
  supabase: SupabaseClient;
  projectId: string;
  actor: { id: string; label: string };
  repo: string;
  token: string;
  baseBranch?: string | undefined;
}): Promise<{ connection: ReturnType<typeof toPublicConnection>; webhookSecret: string | null }> {
  const { supabase, projectId, actor, repo, token, baseBranch } = input;

  let defaultBranch: string;
  try {
    const verified = await verifyConnection({ repo, token });
    defaultBranch = baseBranch || verified.defaultBranch;
  } catch (err) {
    if (err instanceof GithubApiError) {
      throw new HttpError(422, err.message);
    }
    throw new HttpError(502, "Could not reach GitHub. Please try again.");
  }

  // Best-effort: many fine-grained PATs don't grant "Webhooks: write", so
  // failure to auto-register is the expected common case, not a connect
  // failure — see lib/github.ts's registerWebhook. The secret is generated
  // and stored either way so a webhook the user adds manually (using this
  // same secret, shown once below) verifies correctly from the start.
  let webhookId: string | null = null;
  let webhookRegisteredAt: string | null = null;
  let webhookSecret: string | null = null;
  let webhookAutoRegistered = false;

  if (env.BACKEND_PUBLIC_URL) {
    webhookSecret = randomBytes(32).toString("hex");
    try {
      const hook = await registerWebhook(
        { repo, token },
        { url: `${env.BACKEND_PUBLIC_URL}/api/webhooks/github/${projectId}`, secret: webhookSecret },
      );
      webhookId = hook.id;
      webhookRegisteredAt = new Date().toISOString();
      webhookAutoRegistered = true;
    } catch (err) {
      logger.warn({ err, repo, projectId }, "Could not auto-register a GitHub webhook — falling back to manual setup");
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      github_repo: repo,
      github_token_enc: encrypt(token),
      github_default_branch: defaultBranch,
      github_connected_at: new Date().toISOString(),
      github_webhook_secret_enc: webhookSecret ? encrypt(webhookSecret) : null,
      github_webhook_id: webhookId,
      github_webhook_registered_at: webhookRegisteredAt,
    })
    .eq("id", projectId)
    .select(GITHUB_CONNECTION_SELECT)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not save this GitHub connection.");
  }

  await recordActivity(supabase, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.label,
    eventType: "ticket",
    summary: "connected GitHub",
    linkLabel: repo,
    linkTo: "settings",
    meta: defaultBranch,
  });

  return {
    connection: toPublicConnection(data as GithubConnectionRow, projectId),
    // Shown once, like the PAT itself — never re-displayed after this
    // response (github_webhook_secret_enc only ever leaves this process
    // encrypted from here on). Only relevant when auto-registration failed
    // and the user needs to paste it into GitHub's "Add webhook" form.
    webhookSecret: webhookSecret && !webhookAutoRegistered ? webhookSecret : null,
  };
}

function respondWithConnection(res: Response, result: { connection: ReturnType<typeof toPublicConnection>; webhookSecret: string | null }): void {
  res.status(200).json({
    ...result.connection,
    ...(result.webhookSecret ? { webhookSecret: result.webhookSecret } : {}),
  });
}

export async function connectGithub(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { repo, token, baseBranch } = req.body as ConnectGithubInput;
  const supabase = userScopedClient(req);

  const result = await persistGithubConnection({
    supabase,
    projectId: project.id,
    actor: { id: req.user!.id, label: displayNameFromUser(req.user!) },
    repo,
    token,
    baseBranch,
  });

  respondWithConnection(res, result);
}

// Repo-picker flow: same connection, sourced from the caller's account-level
// GitHub OAuth token (Settings' "GitHub Account" card) instead of a PAT
// typed into this request.
export async function connectGithubFromAccount(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { repo, baseBranch } = req.body as ConnectGithubFromAccountInput;
  const supabase = userScopedClient(req);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("github_user_token_enc")
    .eq("id", req.user!.id)
    .single();

  const tokenEnc = (profile as { github_user_token_enc: string | null } | null)?.github_user_token_enc;
  if (profileError || !tokenEnc) {
    throw new HttpError(422, "Connect your GitHub account in Settings first.");
  }

  const result = await persistGithubConnection({
    supabase,
    projectId: project.id,
    actor: { id: req.user!.id, label: displayNameFromUser(req.user!) },
    repo,
    token: decrypt(tokenEnc),
    baseBranch,
  });

  respondWithConnection(res, result);
}

export async function disconnectGithub(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { data: existing } = await supabase
    .from("projects")
    .select("github_repo, github_token_enc, github_webhook_id")
    .eq("id", project.id)
    .single();

  if (existing?.github_repo && existing.github_token_enc && existing.github_webhook_id) {
    const creds: GithubCredentials = { repo: existing.github_repo, token: decrypt(existing.github_token_enc) };
    try {
      await deleteWebhook(creds, existing.github_webhook_id);
    } catch (err) {
      logger.warn({ err, projectId: project.id }, "Could not remove the GitHub webhook on disconnect");
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      github_repo: null,
      github_token_enc: null,
      github_default_branch: null,
      github_connected_at: null,
      github_webhook_secret_enc: null,
      github_webhook_id: null,
      github_webhook_registered_at: null,
    })
    .eq("id", project.id)
    .select(GITHUB_CONNECTION_SELECT)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not disconnect GitHub.");
  }

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket",
    summary: "disconnected GitHub",
  });

  res.status(200).json(toPublicConnection(data as GithubConnectionRow, project.id));
}

// Queues a full repo scan and returns immediately — the actual scan (repo
// fetch + Gemini analysis) runs in the BullMQ worker (jobs/repo-scan.job.ts),
// not this request. Findings land in AI Triage same as a CSV upload; no
// ticket/branch is auto-created here — the user selects which findings to
// ticket, same as the CSV workflow. The frontend polls
// GET /projects/:projectId/scans/:scanId to watch Queued -> Processing ->
// Done/Failed.
export async function scanGithubRepo(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const supabase = userScopedClient(req);

  const github = await loadGithubCreds(supabase, project.id);
  if (!github) {
    throw new HttpError(422, "Connect GitHub in Settings before scanning.");
  }

  const { data: scan, error: scanError } = await supabase
    .from("scans")
    .insert({
      project_id: project.id,
      uploaded_by: req.user!.id,
      source: "github_ai",
      status: "Queued",
      trigger_type: "manual",
      branch: github.defaultBranch,
    })
    .select(SCAN_SELECT)
    .single();

  if (scanError || !scan) {
    throw new HttpError(500, "Could not record this scan.");
  }

  await enqueueRepoScan(
    { scanId: scan.id, projectId: project.id, triggerType: "manual" },
    `manual-${scan.id}`,
  );

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "upload",
    summary: "queued an AI scan of",
    linkLabel: github.creds.repo,
    linkTo: "intake",
    meta: `branch ${github.defaultBranch}`,
  });

  res.status(202).json({ scan: toPublicScan(scan as ScanRow) });
}

export async function inspectJenkinsfile(req: Request, res: Response): Promise<void> {
  const context = await loadJenkinsfileContext(req);
  const entry = findRootJenkinsfile(context.tree);
  const content = entry ? await getBlob(context.creds, entry.sha) : null;
  res.status(200).json({
    repo: context.creds.repo,
    branch: context.branch,
    headSha: context.headSha,
    exists: Boolean(entry),
    path: entry?.path ?? JENKINSFILE_PATH,
    content,
  });
}

export async function proposeJenkinsfile(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const context = await loadJenkinsfileContext(req);
  if (findRootJenkinsfile(context.tree)) throw new HttpError(409, "A Jenkinsfile already exists on the repository's default branch. Refresh the page to review it.");
  const files = await fetchJenkinsContextFiles(context.creds, context.tree);
  const availableCommands = discoverPipelineCommands(context.tree, files);
  let plan;
  try {
    plan = await generatePipelinePlan({ repo: context.creds.repo, branch: context.branch, files, availableCommands });
  } catch {
    throw new HttpError(502, "Could not generate a repository-specific Jenkinsfile. Please try again.");
  }
  const content = buildJenkinsfile(plan);
  const validationError = validateJenkinsfile(content);
  if (validationError) throw new HttpError(502, "The generated Jenkinsfile did not pass validation. Please generate a new draft.");
  const assumptions = [...plan.assumptions];
  if (availableCommands.length === 0 && !assumptions.some((item) => /command|build|test/i.test(item))) {
    assumptions.push("Bankai could not verify a build or test command from the repository manifests. Add the correct commands before running this pipeline.");
  }
  res.status(200).json({
    repo: context.creds.repo,
    branch: context.branch,
    baseSha: context.headSha,
    path: JENKINSFILE_PATH,
    content,
    summary: plan.summary,
    assumptions,
    detectedCommands: availableCommands,
  });
}

export async function acceptJenkinsfileProposal(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const input = req.body as AcceptJenkinsfileProposalInput;
  const validationError = validateJenkinsfile(input.content);
  if (validationError) throw new HttpError(422, validationError);
  const context = await loadJenkinsfileContext(req);
  if (context.headSha !== input.baseSha) throw new HttpError(409, "The default branch changed while you reviewed this draft. Refresh and generate a new Jenkinsfile proposal.");
  if (findRootJenkinsfile(context.tree)) throw new HttpError(409, "A Jenkinsfile was added while you reviewed this draft. Refresh to review the repository version.");

  const branchName = `bankai/jenkinsfile-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await createBranch(context.creds, { baseBranch: context.branch, branchName });
    const { commitSha } = await commitFileToBranch(context.creds, {
      branch: branchName,
      baseSha: context.headSha,
      message: "Add reviewed Jenkins pipeline proposal",
      files: [{ path: JENKINSFILE_PATH, content: input.content }],
    });
    const pullRequest = await createPullRequest(context.creds, {
      head: branchName,
      base: context.branch,
      title: `Add Jenkinsfile for ${context.creds.repo}`,
      body: [
        "Bankai prepared this Jenkinsfile from the repository's manifests and CI configuration. A project member reviewed and accepted the draft before Bankai created this pull request.",
        "",
        `**Summary:** ${input.summary}`,
        ...(input.assumptions.length ? ["", "**Assumptions to review:**", ...input.assumptions.map((item) => `- ${item}`)] : []),
        "",
        "Review the Jenkinsfile and commands before merging. This PR contains only the Jenkinsfile; it does not add deployment steps or credentials.",
        "",
        `Generated from ${context.headSha}. The repository default branch was unchanged at PR creation.`,
      ].join("\n"),
    });
    await recordActivity(userScopedClient(req), {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel: displayNameFromUser(req.user!),
      eventType: "pipeline",
      summary: "opened a Jenkinsfile proposal PR",
      linkLabel: `${context.creds.repo}#${pullRequest.number}`,
      linkTo: "jenkins",
      meta: `branch ${branchName} · commit ${commitSha}`,
    });
    res.status(201).json({ pullRequest, branchName, commitSha, path: JENKINSFILE_PATH });
  } catch (error) {
    await deleteBranch(context.creds, branchName);
    if (error instanceof GithubApiError) throw new HttpError(error.status === 403 ? 403 : 502, error.message);
    throw error;
  }
}

export async function updateJenkinsfilePullRequest(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const input = req.body as UpdateJenkinsfilePullRequestInput;
  const validationError = validateJenkinsfile(input.content);
  if (validationError) throw new HttpError(422, validationError);
  const github = await loadGithubCreds(userScopedClient(req), project.id);
  if (!github) throw new HttpError(422, "Connect GitHub to this project before updating its Jenkinsfile pull request.");
  try {
    const commitSha = await updatePullRequestBranchFile(github.creds, {
      pullRequestNumber: input.prNumber,
      branchName: input.branchName,
      filePath: JENKINSFILE_PATH,
      content: input.content,
      message: "Update reviewed Jenkins pipeline proposal",
    });
    await recordActivity(userScopedClient(req), {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel: displayNameFromUser(req.user!),
      eventType: "pipeline",
      summary: "updated a Jenkinsfile pull request",
      linkLabel: `PR #${input.prNumber}`,
      linkTo: "jenkins",
      meta: `branch ${input.branchName} · commit ${commitSha}`,
    });
    res.status(200).json({ commitSha, branchName: input.branchName, path: JENKINSFILE_PATH });
  } catch (error) {
    if (error instanceof GithubApiError) throw new HttpError(error.status === 403 ? 403 : error.status === 409 ? 409 : 502, error.message);
    throw error;
  }
}
