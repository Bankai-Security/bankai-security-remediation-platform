import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { recordActivity } from "../lib/activity.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { commitFileToBranch, createBranch, createPullRequest, deleteBranch, deleteWebhook, getBlob, getBlobs, getBranchHeadSha, getTree, GithubApiError, registerWebhook, subscribeWebhookEvents, updatePullRequestBranchFile, verifyConnection, type GithubCredentials, type GitTreeEntry } from "../lib/github.js";
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
import type { AcceptHostedCiProposalInput } from "../schemas/hosted-ci.schema.js";

const JENKINSFILE_PATH = "Jenkinsfile";
const HOSTED_CI_PATH = ".github/workflows/bankai-verify.yml";
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
      if (!/^[A-Za-z0-9:_-]{1,60}$/.test(name)) continue;
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

function hasHostedCiWorkflow(tree: GitTreeEntry[]): boolean {
  return tree.some((entry) => entry.type === "blob" && entry.path === HOSTED_CI_PATH);
}

function buildHostedCiWorkflow(tree: GitTreeEntry[], commands: Array<PipelineCommand & { evidence: string }>): string {
  if (!commands.some((item) => item.stage === "Build" || item.stage === "Test")) {
    throw new HttpError(422, "Bankai could not verify a build or test command in this repository. Add those commands to a manifest before setting up hosted CI.");
  }
  const paths = new Set(tree.map((entry) => entry.path.toLowerCase()));
  const setup: string[] = [
    "      - name: Check out pull request",
    "        uses: actions/checkout@v4",
  ];
  if ([...paths].some((path) => path.endsWith("package.json"))) {
    setup.push("      - name: Set up Node.js", "        uses: actions/setup-node@v4", "        with:", "          node-version: '22'");
  }
  if (paths.has("requirements.txt") || paths.has("pyproject.toml")) {
    setup.push("      - name: Set up Python", "        uses: actions/setup-python@v5", "        with:", "          python-version: '3.x'");
  }
  if (paths.has("go.mod")) setup.push("      - name: Set up Go", "        uses: actions/setup-go@v5", "        with:", "          go-version-file: go.mod");
  if (paths.has("cargo.toml")) setup.push("      - name: Set up Rust", "        uses: dtolnay/rust-toolchain@stable");
  if (paths.has("pom.xml") || paths.has("build.gradle") || paths.has("build.gradle.kts")) {
    setup.push("      - name: Set up Java", "        uses: actions/setup-java@v4", "        with:", "          distribution: temurin", "          java-version: '17'");
  }
  const commandsYaml = commands.map((item, index) => [
    `      - name: ${item.stage} ${index + 1}`,
    "        run: |",
    `          ${item.command}`,
  ].join("\n"));
  return [
    "name: Bankai verification",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize]",
    `    paths-ignore: ['${HOSTED_CI_PATH}']`,
    "permissions:",
    "  contents: read",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 20",
    "    steps:",
    ...setup,
    ...commandsYaml,
    "",
  ].join("\n");
}

function validateHostedCiWorkflow(content: string, availableCommands: Array<PipelineCommand & { evidence: string }>): string | null {
  if (content.length > 50_000) return "The hosted workflow is too large.";
  if (/\$\{\{\s*secrets\.|pull_request_target|workflow_dispatch|workflow_run|deploy|deployment|add-mask|ghp_[\w-]+|AKIA[0-9A-Z]{16}/i.test(content)) {
    return "The hosted workflow contains a credential, elevated event, or deployment action that Bankai does not allow.";
  }
  if (!content.includes(`paths-ignore: ['${HOSTED_CI_PATH}']`) || !content.includes("contents: read")) {
    return "The workflow must keep read-only repository permissions and skip its own bootstrap pull request.";
  }
  const uses = [...content.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);
  const allowedActions = new Set(["actions/checkout@v4", "actions/setup-node@v4", "actions/setup-python@v5", "actions/setup-go@v5", "dtolnay/rust-toolchain@stable", "actions/setup-java@v4"]);
  if (uses.some((action) => !allowedActions.has(action ?? ""))) return "The workflow uses an action that is not in Bankai's reviewed allowlist.";
  const allowed = new Set(availableCommands.map((item) => item.command));
  const commands: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*run:\s*\|\s*$/.test(lines[index] ?? "")) continue;
    const baselineIndent = (lines[index]!.match(/^\s*/) ?? [""])[0]!.length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      const indent = (line.match(/^\s*/) ?? [""])[0]!.length;
      if (indent <= baselineIndent) { index -= 1; break; }
      commands.push(line.trim());
    }
  }
  if (commands.length === 0 || commands.some((command) => !allowed.has(command))) return "Each shell command must exactly match a command verified from the repository manifests.";
  return null;
}

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface GithubConnectionRow {
  github_repo: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
  github_webhook_registered_at: string | null;
  github_webhook_workflow_run_enabled?: boolean;
}

function toPublicConnection(row: GithubConnectionRow, projectId: string) {
  return {
    connected: row.github_connected_at !== null,
    repo: row.github_repo,
    defaultBranch: row.github_default_branch,
    connectedAt: row.github_connected_at,
    webhookRegistered: row.github_webhook_registered_at !== null,
    workflowRunReporting: row.github_webhook_workflow_run_enabled === true,
    // Present even when auto-registration hasn't happened, so the frontend
    // can always show "point GitHub here" in a manual-setup banner — this
    // is a deterministic function of BACKEND_PUBLIC_URL + the project id,
    // not something that needs a DB round trip to know.
    webhookUrl: env.BACKEND_PUBLIC_URL ? `${env.BACKEND_PUBLIC_URL}/api/webhooks/github/${projectId}` : null,
  };
}

const GITHUB_CONNECTION_SELECT = "github_repo, github_default_branch, github_connected_at, github_webhook_registered_at, github_webhook_workflow_run_enabled";

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
  githubOAuthUserId?: string | undefined;
  baseBranch?: string | undefined;
}): Promise<{ connection: ReturnType<typeof toPublicConnection>; webhookSecret: string | null }> {
  const { supabase, projectId, actor, repo, token, baseBranch, githubOAuthUserId } = input;

  let defaultBranch: string;
  let initialHeadSha: string;
  try {
    const verified = await verifyConnection({ repo, token });
    defaultBranch = baseBranch || verified.defaultBranch;
    initialHeadSha = await getBranchHeadSha({ repo, token }, defaultBranch);
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
  let workflowRunReporting = false;

  if (env.BACKEND_PUBLIC_URL) {
    const { data: previous } = await supabase.from("projects")
      .select("github_repo,github_webhook_id,github_webhook_secret_enc,github_webhook_registered_at")
      .eq("id", projectId).maybeSingle();
    if (previous?.github_repo === repo && previous.github_webhook_id && previous.github_webhook_secret_enc) {
      webhookId = previous.github_webhook_id;
      webhookSecret = decrypt(previous.github_webhook_secret_enc);
      webhookRegisteredAt = previous.github_webhook_registered_at ?? new Date().toISOString();
      webhookAutoRegistered = true;
      try { await subscribeWebhookEvents({ repo, token }, webhookId!); workflowRunReporting = true; }
      catch (err) { logger.warn({ err, repo, projectId }, "Could not update existing GitHub webhook subscriptions"); }
    } else {
      webhookSecret = randomBytes(32).toString("hex");
      try {
        const hook = await registerWebhook(
          { repo, token },
          { url: `${env.BACKEND_PUBLIC_URL}/api/webhooks/github/${projectId}`, secret: webhookSecret },
        );
        webhookId = hook.id;
        webhookRegisteredAt = new Date().toISOString();
        webhookAutoRegistered = true;
        workflowRunReporting = true;
      } catch (err) {
        logger.warn({ err, repo, projectId }, "Could not auto-register a GitHub webhook — falling back to manual setup");
      }
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      github_repo: repo,
      github_token_enc: encrypt(token),
      github_oauth_user_id: githubOAuthUserId ?? null,
      github_default_branch: defaultBranch,
      github_connected_at: new Date().toISOString(),
      github_webhook_secret_enc: webhookSecret ? encrypt(webhookSecret) : null,
      github_webhook_id: webhookId,
      github_webhook_registered_at: webhookRegisteredAt,
      github_webhook_workflow_run_enabled: workflowRunReporting,
    })
    .eq("id", projectId)
    .select(GITHUB_CONNECTION_SELECT)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not save this GitHub connection.");
  }

  // Onboarding always starts with a baseline scan. The deterministic event
  // key makes reconnects and request retries safe while still recovering a
  // scan that was persisted before Redis was temporarily unavailable.
  const headSha = initialHeadSha;
  const eventKey = `initial:${repo}:${defaultBranch}:${headSha}`;
  let initialScan = await supabase.from("scans").insert({
    project_id: projectId,
    uploaded_by: actor.id,
    source: "github_ai",
    status: "Queued",
    trigger_type: "initial",
    scan_type: "baseline",
    branch: defaultBranch,
    commit_sha: headSha,
    event_key: eventKey,
  }).select("id").maybeSingle();
  if (initialScan.error?.code === "23505") {
    initialScan = await supabase.from("scans").select("id").eq("project_id", projectId).eq("event_key", eventKey).maybeSingle();
  }
  if (initialScan.error || !initialScan.data) {
    throw new HttpError(503, "GitHub is connected, but Bankai could not queue the initial scan. Reconnect GitHub to retry safely.");
  }
  try {
    await enqueueRepoScan(
      { scanId: initialScan.data.id, projectId, triggerType: "initial", scanType: "baseline", headSha },
      `initial-${projectId}-${headSha}`,
    );
  } catch (err) {
    logger.error({ err, projectId }, "Could not queue the initial GitHub repository scan");
    throw new HttpError(503, "GitHub is connected, but the initial scan is waiting for the worker queue. Reconnect GitHub to retry safely.");
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
    githubOAuthUserId: req.user!.id,
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
      github_webhook_workflow_run_enabled: false,
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

export async function proposeHostedCiWorkflow(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const context = await loadJenkinsfileContext(req);
  if (hasHostedCiWorkflow(context.tree)) throw new HttpError(409, "A hosted CI workflow already exists on the default branch.");
  const files = await fetchJenkinsContextFiles(context.creds, context.tree);
  const commands = discoverPipelineCommands(context.tree, files);
  const content = buildHostedCiWorkflow(context.tree, commands);
  const validationError = validateHostedCiWorkflow(content, commands);
  if (validationError) throw new HttpError(422, validationError);
  res.status(200).json({
    repo: context.creds.repo,
    branch: context.branch,
    baseSha: context.headSha,
    path: HOSTED_CI_PATH,
    content,
    summary: `GitHub Actions will run ${commands.filter((item) => item.stage !== "Install").map((item) => item.command).join(" and ")} for pull request revisions.`,
    detectedCommands: commands,
    assumptions: ["The workflow requests read-only repository access and uses no deployment destination or credentials.", "It starts after a person reviews and merges the workflow proposal pull request."],
  });
}

export async function acceptHostedCiWorkflow(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const input = req.body as AcceptHostedCiProposalInput;
  const context = await loadJenkinsfileContext(req);
  if (context.headSha !== input.baseSha) throw new HttpError(409, "The default branch changed while you reviewed this workflow. Generate a new proposal.");
  if (hasHostedCiWorkflow(context.tree)) throw new HttpError(409, "A hosted CI workflow was added while you reviewed this proposal.");
  const files = await fetchJenkinsContextFiles(context.creds, context.tree);
  const commands = discoverPipelineCommands(context.tree, files);
  const validationError = validateHostedCiWorkflow(input.content, commands);
  if (validationError) throw new HttpError(422, validationError);
  const expectedContent = buildHostedCiWorkflow(context.tree, commands);
  if (input.content.replace(/\r\n/g, "\n") !== expectedContent.replace(/\r\n/g, "\n")) {
    throw new HttpError(422, "The reviewed workflow must match Bankai's complete generated draft. Regenerate it if repository commands changed.");
  }

  const supabase = userScopedClient(req);
  const { data: config } = await supabase.from("projects").select("ci_bootstrap_status,ci_bootstrap_pr_url").eq("id", project.id).single();
  if (config?.ci_bootstrap_status === "pr_open" && config.ci_bootstrap_pr_url) {
    throw new HttpError(409, `A hosted CI setup pull request is already open: ${config.ci_bootstrap_pr_url}`);
  }

  const branchName = `bankai/hosted-ci-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await createBranch(context.creds, { baseBranch: context.branch, branchName });
    const { commitSha } = await commitFileToBranch(context.creds, {
      branch: branchName,
      baseSha: context.headSha,
      message: "Add reviewed GitHub Actions verification workflow",
      files: [{ path: HOSTED_CI_PATH, content: input.content }],
    });
    const pullRequest = await createPullRequest(context.creds, {
      head: branchName,
      base: context.branch,
      title: "Add Bankai hosted CI verification",
      body: [
        "Bankai prepared this GitHub Actions workflow from build and test commands verified in repository manifests. A project member reviewed the complete workflow before Bankai opened this pull request.",
        "",
        "The workflow uses read-only repository permissions, contains no deployment destination or credentials, and runs only for pull request revisions. It skips its own setup PR.",
        "",
        "Review and merge this pull request to enable hosted CI. Bankai will keep scans and ticket triage available while setup is pending; it will not treat pending setup as a passing check.",
        "",
        `Generated from ${context.headSha}. No files other than ${HOSTED_CI_PATH} were changed.`,
      ].join("\n"),
    });
    const { error } = await supabase.from("projects").update({
      verification_provider: "hosted_ci",
      ci_bootstrap_status: "pr_open",
      ci_bootstrap_pr_url: pullRequest.url,
    }).eq("id", project.id);
    if (error) throw new HttpError(500, "The setup pull request was opened, but Bankai could not save its pending status.");
    await recordActivity(supabase, { projectId: project.id, actorId: req.user!.id, actorLabel: displayNameFromUser(req.user!),
      eventType: "pipeline", summary: "opened a hosted CI setup pull request", linkLabel: `PR #${pullRequest.number}`, linkTo: "settings", meta: `commit ${commitSha}` });
    res.status(201).json({ pullRequest, branchName, commitSha, path: HOSTED_CI_PATH, setupStatus: "pr_open" });
  } catch (error) {
    await deleteBranch(context.creds, branchName);
    if (error instanceof HttpError) throw error;
    if (error instanceof GithubApiError) throw new HttpError(error.status === 403 ? 403 : 502, error.message);
    throw error;
  }
}
