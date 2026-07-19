import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { recordActivity } from "../lib/activity.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { deleteWebhook, GithubApiError, registerWebhook, verifyConnection, type GithubCredentials } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { enqueueRepoScan } from "../lib/queue.js";
import { requireRole } from "../lib/roles.js";
import { SCAN_SELECT, toPublicScan, type ScanRow } from "../lib/scans.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { loadGithubCreds } from "../lib/ticketing.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { ConnectGithubFromAccountInput, ConnectGithubInput } from "../schemas/github.schema.js";

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
    { scanId: scan.id, projectId: project.id, triggerType: "manual", baseSha: null, headSha: null },
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
