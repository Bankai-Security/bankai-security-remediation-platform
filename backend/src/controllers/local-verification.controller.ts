import type { Request, Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import { env } from "../env.js";
import { requireRole } from "../lib/roles.js";
import { LocalRunnerCapabilitiesSchema } from "../lib/local-runner-protocol.js";
import { artifactDigest } from "../lib/quincy-manifest.js";

const TaskId = z.uuid();

export async function listLocalVerificationTasks(req: Request, res: Response): Promise<void> {
  const db = createUserScopedSupabaseClient(req.accessToken as string);
  const { data, error } = await db.from("local_runner_tasks")
    .select("id, remediation_id, attempt_id, finding_id, execution_id, repository, baseline_sha, candidate_sha, profile, policy_id, state, result, lease_expires_at, last_sequence, created_at, updated_at, completed_at")
    .eq("project_id", req.project!.id).order("created_at", { ascending: false }).limit(100);
  if (error) throw new HttpError(500, "Could not load local verification history.");
  const { data: runners, error: runnerError } = await db.from("local_runner_installations")
    .select("id, public_key, protocol_version, capabilities, status, last_seen_at, created_at, revoked_at")
    .eq("project_id", req.project!.id).order("created_at", { ascending: false });
  if (runnerError) throw new HttpError(500, "Could not load paired runner status.");
  const { data: remediationRows, error: remediationError } = await db.from("remediations")
    .select("id, finding_id, repository_id, state, current_attempt_id")
    .eq("project_id", req.project!.id).in("state", ["PATCH_GENERATED", "VERIFICATION_PENDING"])
    .not("current_attempt_id", "is", null).order("updated_at", { ascending: false }).limit(100);
  if (remediationError) throw new HttpError(500, "Could not load remediations ready for local verification.");
  const rows = remediationRows ?? [];
  const attemptIds = rows.map((row) => row.current_attempt_id).filter((id): id is string => typeof id === "string");
  const [attemptResult, choiceResult, findingResult] = await Promise.all([
    attemptIds.length ? db.from("remediation_attempts").select("id, remediation_id, attempt_number, base_sha, candidate_sha, verification_profile").in("id", attemptIds) : Promise.resolve({ data: [], error: null }),
    db.from("local_verification_choices").select("attempt_id, choice, updated_at").eq("project_id", req.project!.id),
    rows.length ? db.from("findings").select("id, title").in("id", rows.map((row) => row.finding_id)) : Promise.resolve({ data: [], error: null }),
  ]);
  if (attemptResult.error || choiceResult.error || findingResult.error) throw new HttpError(500, "Could not load local verification choices.");
  const attemptsById = new Map((attemptResult.data ?? []).map((item) => [item.id, item]));
  const choicesByAttempt = new Map((choiceResult.data ?? []).map((item) => [item.attempt_id, item]));
  const findingsById = new Map((findingResult.data ?? []).map((item) => [item.id, item]));
  const eligible = rows.flatMap((row) => {
    const attempt = row.current_attempt_id ? attemptsById.get(row.current_attempt_id) : undefined;
    const finding = findingsById.get(row.finding_id);
    return attempt && finding && attempt.verification_profile === "jenkins-schrift-comparison-v1"
      ? [{ ...row, attempt, finding_title: finding.title, choice: choicesByAttempt.get(attempt.id) ?? null }]
      : [];
  });
  res.json({ enabled: env.LOCAL_RUNNER_ENABLED, dispatch_enabled: env.LOCAL_RUNNER_ENABLED, tasks: data ?? [], runners: runners ?? [], eligible });
}

export async function chooseLocalVerification(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const input = z.object({ choice: z.enum(["run", "skip"]) }).strict().parse(req.body);
  if (input.choice === "run" && !env.LOCAL_RUNNER_ENABLED) throw new HttpError(503, "Local runner dispatch is disabled by the server feature flag.");
  const remediationId = TaskId.parse(req.params.remediationId);
  const db = createUserScopedSupabaseClient(req.accessToken as string);
  const { data: remediation, error: readError } = await db.from("remediations")
    .select("repository_id").eq("id", remediationId).eq("project_id", req.project!.id).maybeSingle();
  if (readError || !remediation) throw new HttpError(404, "Eligible remediation was not found.");
  const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).parse(remediation.repository_id);
  const { data, error } = await supabaseAdmin.rpc("request_local_verification", {
    p_request: { project_id: req.project!.id, remediation_id: remediationId, selected_by: req.user!.id,
      choice: input.choice, execution_id: randomUUID(), repository },
  });
  if (error) throw new HttpError(409, "Local verification choice could not be saved for this attempt.");
  res.status(input.choice === "run" ? 202 : 200).json(data);
}

export async function createRunnerPairingCode(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const code = randomBytes(24).toString("base64url");
  const codeDigest = `sha256-${createHash("sha256").update(code).digest("hex")}`;
  const { data, error } = await supabaseAdmin.rpc("issue_local_runner_pairing_code", {
    p_project_id: req.project!.id, p_owner_id: req.user!.id, p_code_digest: codeDigest,
  });
  if (error || !data) throw new HttpError(500, "Could not create a companion pairing code.");
  res.status(201).json({ pairing_code: code, expires_at: data });
}

export async function exchangeRunnerPairingCode(req: Request, res: Response): Promise<void> {
  const input = z.object({
    pairing_code: z.string().min(30).max(80).regex(/^[A-Za-z0-9_-]+$/),
    public_key: z.string().min(32).max(1024),
    capabilities: LocalRunnerCapabilitiesSchema,
  }).strict().parse(req.body);
  const token = randomBytes(32).toString("base64url");
  const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const codeDigest = `sha256-${createHash("sha256").update(input.pairing_code).digest("hex")}`;
  const tokenDigest = `sha256-${createHash("sha256").update(token).digest("hex")}`;
  const { data, error } = await supabaseAdmin.rpc("consume_local_runner_pairing_code", {
    p_code_digest: codeDigest, p_public_key: input.public_key,
    p_capabilities: input.capabilities, p_token_digest: tokenDigest, p_token_expires_at: tokenExpiresAt,
  });
  if (error || !data?.id) throw new HttpError(401, "Pairing code is invalid, expired, or already used.");
  res.status(201).json({ runner_id: data.id, access_token: token, token_type: "Bearer", expires_at: tokenExpiresAt });
}

export async function revokeLocalRunner(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  const runnerId = TaskId.parse(req.params.runnerId);
  const { data, error } = await supabaseAdmin.rpc("revoke_local_runner", {
    p_project_id: req.project!.id, p_runner_id: runnerId,
  });
  if (error) throw new HttpError(500, "Could not revoke the companion.");
  if (!data) throw new HttpError(404, "Paired companion not found.");
  res.json({ revoked: true });
}

export async function cancelLocalVerificationTask(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const taskId = TaskId.parse(req.params.taskId);
  const db = createUserScopedSupabaseClient(req.accessToken as string);
  const { data: task, error: readError } = await db.from("local_runner_tasks").select("id, state")
    .eq("id", taskId).eq("project_id", req.project!.id).maybeSingle();
  if (readError || !task) throw new HttpError(404, "Local verification task not found.");
  const { data, error } = await supabaseAdmin.rpc("request_local_runner_cancel", { p_task_id: taskId });
  if (error) throw new HttpError(409, "Local verification task could not be cancelled.");
  res.json({ task: data });
}

export async function downloadLocalVerificationArtifact(req: Request, res: Response): Promise<void> {
  const taskId = TaskId.parse(req.params.taskId);
  const name = z.enum(["build-log", "test-report", "scan-evidence"]).parse(req.params.name);
  const db = createUserScopedSupabaseClient(req.accessToken as string);
  const { data: task, error: taskError } = await db.from("local_runner_tasks").select("id, state")
    .eq("id", taskId).eq("project_id", req.project!.id).maybeSingle();
  if (taskError || !task || !["passed", "failed", "cancelled", "incomplete", "infrastructure_failure"].includes(task.state)) {
    throw new HttpError(404, "Local verification artifact not found.");
  }
  const { data: artifact, error: artifactError } = await db.from("local_runner_artifacts")
    .select("storage_key, size_bytes, content_type, digest").eq("task_id", taskId).eq("name", name).maybeSingle();
  if (artifactError || !artifact) throw new HttpError(404, "Local verification artifact not found.");
  const stored = await supabaseAdmin.storage.from("local-runner-artifacts").download(artifact.storage_key);
  if (stored.error) throw new HttpError(404, "Local verification artifact not found.");
  const bytes = new Uint8Array(await stored.data.arrayBuffer());
  if (bytes.byteLength !== artifact.size_bytes || artifactDigest(bytes) !== artifact.digest) {
    throw new HttpError(409, "Stored local verification artifact failed integrity validation.");
  }
  res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}.bin"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ETag: `\"${artifact.digest}\"` });
  res.send(Buffer.from(bytes));
}
