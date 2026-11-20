import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { LocalRunnerControlPlane } from "../lib/local-runner-control-plane.js";
import { LocalRunnerArtifactSchema, LocalRunnerCapabilitiesSchema, LocalRunnerHeartbeatSchema, LocalRunnerProgressSchema, LocalRunnerResultSchema } from "../lib/local-runner-protocol.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { reportLocalVerificationCommitStatus } from "../lib/github.js";
import { loadGithubCreds } from "../lib/ticketing.js";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";

function runnerId(res: Response): string {
  return z.object({ id: z.uuid() }).parse(res.locals.localRunner).id;
}

export async function claimTask(_req: Request, res: Response): Promise<void> {
  const task = await new LocalRunnerControlPlane(supabaseAdmin).claim(runnerId(res));
  res.json({ task });
}

export async function updateCapabilities(req: Request, res: Response): Promise<void> {
  const capabilities = LocalRunnerCapabilitiesSchema.parse(req.body);
  const { data, error } = await supabaseAdmin.rpc("update_local_runner_capabilities", {
    p_runner_id: runnerId(res), p_capabilities: capabilities,
  });
  if (error || !data) throw new HttpError(401, "Runner credential is revoked or unavailable.");
  res.json({ updated: true });
}

export async function heartbeatTask(req: Request, res: Response): Promise<void> {
  const heartbeat = LocalRunnerHeartbeatSchema.parse(req.body);
  const task = await new LocalRunnerControlPlane(supabaseAdmin).heartbeat(
    runnerId(res), heartbeat.lease_id, heartbeat.execution_id, heartbeat.heartbeat_id,
  );
  res.json({ task });
}

export async function reportTaskProgress(req: Request, res: Response): Promise<void> {
  const progress = LocalRunnerProgressSchema.parse(req.body);
  if (progress.execution_id !== req.params.executionId) throw new HttpError(400, "Execution identity mismatch.");
  const task = await new LocalRunnerControlPlane(supabaseAdmin).progress(runnerId(res), progress.lease_id, progress);
  res.json({ task });
}

export async function uploadTaskArtifact(req: Request, res: Response): Promise<void> {
  const runner = z.object({ id: z.uuid(), projectId: z.uuid() }).parse(res.locals.localRunner);
  const executionId = z.string().min(1).max(128).parse(req.params.executionId);
  const leaseId = z.uuid().parse(req.body.lease_id);
  const name = z.enum(["build-log", "test-report", "scan-evidence"]).parse(req.body.name);
  const file = req.file;
  if (!file) throw new HttpError(400, "Artifact file is required.");
  const contentType = file.mimetype.toLowerCase();
  const allowedTypes: Record<typeof name, string[]> = {
    "build-log": ["text/plain", "application/json", "application/octet-stream"],
    "test-report": ["text/plain", "application/json", "application/xml", "application/octet-stream"],
    "scan-evidence": ["application/json", "application/octet-stream"],
  };
  if (!allowedTypes[name].includes(contentType)) throw new HttpError(415, "Artifact content type is not allowed.");
  const sha = `sha256-${createHash("sha256").update(file.buffer).digest("hex")}`;
  const descriptor = LocalRunnerArtifactSchema.parse({ name, size_bytes: file.size, digest: sha, content_type: contentType });
  const { data: task, error: taskError } = await supabaseAdmin.from("local_runner_tasks")
    .select("id, project_id").eq("runner_id", runner.id).eq("project_id", runner.projectId)
    .eq("execution_id", executionId).eq("lease_id", leaseId).maybeSingle();
  if (taskError || !task) throw new HttpError(404, "Leased task not found.");
  const storageKey = `${runner.projectId}/${task.id}/${name}/${sha.slice("sha256-".length)}`;
  const storage = supabaseAdmin.storage.from("local-runner-artifacts");
  const uploaded = await storage.upload(storageKey, file.buffer, { contentType, upsert: false });
  let createdObject = !uploaded.error;
  if (uploaded.error) {
    const existing = await storage.download(storageKey);
    if (existing.error) throw new HttpError(500, "Could not store runner artifact.");
    const bytes = new Uint8Array(await existing.data.arrayBuffer());
    const existingDigest = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    if (existingDigest !== descriptor.digest || bytes.byteLength !== descriptor.size_bytes) {
      throw new HttpError(409, "Existing artifact object conflicts with this upload.");
    }
    createdObject = false;
  }
  const { data, error } = await supabaseAdmin.rpc("record_local_runner_artifact", {
    p_runner_id: runner.id, p_lease_id: leaseId, p_execution_id: executionId,
    p_name: name, p_storage_key: storageKey, p_size_bytes: descriptor.size_bytes,
    p_content_type: descriptor.content_type, p_digest: descriptor.digest,
  });
  if (error || !data) {
    if (createdObject) await storage.remove([storageKey]);
    throw new HttpError(409, "Artifact does not match an active leased task or conflicts with prior evidence.");
  }
  res.status(201).json({ artifact: descriptor });
}

export async function getTaskControlState(req: Request, res: Response): Promise<void> {
  const executionId = z.string().min(1).max(128).parse(req.params.executionId);
  const runner = z.object({ id: z.uuid(), projectId: z.uuid() }).parse(res.locals.localRunner);
  const { data, error } = await supabaseAdmin.from("local_runner_tasks")
    .select("execution_id, state, lease_id, lease_expires_at, cancel_requested_at, last_sequence")
    .eq("execution_id", executionId).eq("runner_id", runner.id).eq("project_id", runner.projectId).maybeSingle();
  if (error || !data) throw new HttpError(404, "Leased task not found.");
  res.json({ task: data, cancel_requested: data.state === "cancelling" });
}

export async function submitTaskResult(req: Request, res: Response): Promise<void> {
  const result = LocalRunnerResultSchema.parse(req.body);
  if (result.execution_id !== req.params.executionId) throw new HttpError(400, "Execution identity mismatch.");
  try {
    const task = await new LocalRunnerControlPlane(supabaseAdmin).finalize(runnerId(res), result.lease_id, result);
    const terminal = z.object({ id: z.uuid(), project_id: z.uuid(), candidate_sha: z.string().regex(/^[0-9a-f]{40}$/), state: z.string() }).passthrough().parse(task);
    const github = await loadGithubCreds(supabaseAdmin, terminal.project_id);
    if (github) {
      const state = terminal.state === "passed" ? "pending" : terminal.state === "failed" ? "failure" : "error";
      const description = terminal.state === "passed"
        ? "Local run passed; awaiting trusted verification."
        : terminal.state === "failed" ? "Local Jenkins verification failed."
          : "Local Jenkins verification did not complete.";
      const targetUrl = `${env.FRONTEND_ORIGIN.replace(/\/$/, "")}/workspace/${terminal.project_id}/local-verification`;
      try {
        await reportLocalVerificationCommitStatus(github.creds, { sha: terminal.candidate_sha, state, description, targetUrl });
      } catch (error) {
        logger.warn({ error, taskId: terminal.id, sha: terminal.candidate_sha }, "Could not publish the local Jenkins commit status");
      }
    }
    res.json({ task });
  } catch {
    throw new HttpError(409, "Runner result failed identity, manifest, or artifact verification.");
  }
}
