import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { recordActivity } from "../lib/activity.js";
import { requireRole } from "../lib/roles.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueueJenkinsRetry } from "../lib/queue.js";

const MAX_RETRIES = 2;
const redact = (value: string) => value
  .replace(/(password|token|secret|authorization|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]")
  .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
  .slice(0, 12_000);

export async function claimJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const deviceId = req.body?.deviceId;
  const jobUrl = req.body?.jobUrl;
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId) || typeof jobUrl !== "string" || jobUrl.length > 2048) {
    throw new HttpError(400, "A desktop ID and selected Jenkins job are required.");
  }
  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: staleRuns } = await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "desktop_disconnected",
    failure_summary: "Bankai Desktop stopped reporting before this build finished. Check Jenkins before retrying.", completed_at: new Date().toISOString() })
    .eq("project_id", req.project!.id).eq("status", "in_progress").lt("claimed_at", staleBefore).select("ticket_id");
  for (const stale of staleRuns ?? []) await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai Desktop stopped reporting before this build finished. Check Jenkins before retrying." })
    .eq("id", stale.ticket_id).eq("project_id", req.project!.id);
  const { data: queued, error } = await supabaseAdmin.from("pipeline_runs").select("*")
    .eq("project_id", req.project!.id).eq("status", "queued").order("created_at").limit(1).maybeSingle();
  if (error) throw new HttpError(500, "Could not check for Jenkins work.");
  if (!queued) { res.status(204).end(); return; }
  const { data: ticket } = await supabaseAdmin.from("tickets").select("github_pr_state, github_pr_number")
    .eq("id", queued.ticket_id).eq("project_id", req.project!.id).maybeSingle();
  if (!ticket || ticket.github_pr_state !== "open" || ticket.github_pr_number !== queued.pull_request_number) {
    await supabaseAdmin.from("pipeline_runs").update({ status: "cancelled", conclusion: "pull_request_closed", completed_at: new Date().toISOString() }).eq("id", queued.id).eq("status", "queued");
    res.status(204).end(); return;
  }
  const { data: claimed, error: claimError } = await supabaseAdmin.from("pipeline_runs").update({
    status: "in_progress", claimed_by: deviceId, claimed_at: new Date().toISOString(), started_at: new Date().toISOString(),
    jenkins_job_url: jobUrl, updated_at: new Date().toISOString(),
  }).eq("id", queued.id).eq("status", "queued").select("*").maybeSingle();
  if (claimError) throw new HttpError(500, "Could not claim Jenkins work.");
  if (!claimed) { res.status(204).end(); return; }
  await supabaseAdmin.from("tickets").update({ ci_status: "running", ci_error: null }).eq("id", claimed.ticket_id).eq("project_id", req.project!.id);
  res.status(200).json({ runId: claimed.id, ticketId: claimed.ticket_id, commitSha: claimed.commit_sha, branch: claimed.head_branch,
    pullRequestNumber: claimed.pull_request_number, retryCount: claimed.retry_count, jobUrl });
}

export async function finishJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { runId } = req.params;
  const { deviceId, state, buildUrl, buildNumber, commitSha, failureLog } = req.body ?? {};
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId) || !["passed", "failed", "cancelled"].includes(state)
    || typeof buildUrl !== "string" || buildUrl.length > 2048) {
    throw new HttpError(400, "The Jenkins result is incomplete or invalid.");
  }
  const { data: run, error: loadError } = await supabaseAdmin.from("pipeline_runs").select("*").eq("id", runId)
    .eq("project_id", req.project!.id).eq("claimed_by", deviceId).eq("status", "in_progress").maybeSingle();
  if (loadError || !run) throw new HttpError(409, "This Jenkins run is no longer claimed by this desktop.");
  try {
    const root = new URL(run.jenkins_job_url);
    const build = new URL(buildUrl);
    const rootPath = root.pathname.replace(/\/$/, "");
    if (!(["https:", "http:"].includes(build.protocol)) || build.origin !== root.origin || !(build.pathname === rootPath || build.pathname.startsWith(`${rootPath}/`))) throw new Error("outside selected Jenkins job");
  } catch {
    throw new HttpError(400, "The build link is outside the selected Jenkins job.");
  }
  if (commitSha && run.commit_sha && commitSha.toLowerCase() !== run.commit_sha.toLowerCase()) {
    await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "commit_mismatch", failure_summary: "Jenkins built a different commit than the remediation PR." }).eq("id", run.id);
    await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_error: "Jenkins built a different commit than the remediation PR." }).eq("id", run.ticket_id);
    res.status(409).json({ error: "Jenkins built a different commit than the remediation PR; review is required." }); return;
  }
  if (!commitSha && state !== "cancelled") {
    await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "commit_unavailable", failure_summary: "Jenkins did not report the commit SHA, so Bankai cannot verify this build matches the PR." }).eq("id", run.id);
    await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_run_url: buildUrl, ci_error: "Jenkins did not report a commit SHA, so Bankai could not verify this build matches the PR." }).eq("id", run.ticket_id);
    res.status(409).json({ error: "Jenkins did not report a commit SHA; review is required." }); return;
  }
  if (commitSha && !/^[0-9a-f]{40}$/i.test(commitSha)) {
    await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "invalid_commit_sha", failure_summary: "Jenkins did not report a full commit SHA, so Bankai cannot verify this build matches the PR." }).eq("id", run.id);
    await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_run_url: buildUrl, ci_error: "Jenkins did not report a full commit SHA, so Bankai could not verify this build matches the PR." }).eq("id", run.ticket_id);
    res.status(409).json({ error: "Jenkins did not report a full commit SHA; review is required." }); return;
  }
  const log = typeof failureLog === "string" ? redact(failureLog) : "";
  const summary = state === "failed" ? (log.split(/\r?\n/).filter(Boolean).slice(-8).join("\n").slice(0, 1500) || "Jenkins reported a failed build.") : null;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("pipeline_runs").update({ status: "completed", conclusion: state, html_url: buildUrl,
    jenkins_build_number: Number.isInteger(buildNumber) ? buildNumber : null, completed_at: now, updated_at: now, failure_summary: summary }).eq("id", run.id);
  if (error) throw new HttpError(500, "Could not save the Jenkins result.");

  let ciStatus = state === "passed" ? "passed" : state === "cancelled" ? "cancelled" : "failed";
  const eligible = state === "failed"
    && /(test|assert|compil|lint|checkstyle|build failed|failed to compile|failure:|error:)/i.test(log)
    && !/(401|403|credential|permission|authentication|agent offline|connection refused|timed? out|no space left|jenkins.*unavailable|setup:|configuration|branch discovery|no matching)/i.test(log);
  if (eligible && run.retry_count < MAX_RETRIES) {
    await supabaseAdmin.from("tickets").update({ ci_status: "retrying", ci_run_url: buildUrl, ci_error: summary })
      .eq("id", run.ticket_id).eq("project_id", req.project!.id);
    try {
      await enqueueJenkinsRetry({ ticketId: run.ticket_id, projectId: req.project!.id, runId: run.id, retryCount: run.retry_count + 1, failureLog: log });
      ciStatus = "retrying";
    } catch {
      ciStatus = "needs_review";
    }
  } else if (state === "failed" && (run.retry_count >= MAX_RETRIES || !eligible)) ciStatus = "needs_review";
  const ciError = ciStatus === "needs_review" ? (eligible ? "The automatic retry limit was reached. Review the Jenkins build and update the pull request." : "Jenkins failed for a setup or environment reason. Fix the Jenkins configuration, then review the pull request.") : summary;
  if (ciStatus !== "retrying") await supabaseAdmin.from("tickets").update({ ci_status: ciStatus, ci_run_url: buildUrl, ci_error: ciError }).eq("id", run.ticket_id).eq("project_id", req.project!.id);
  await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai Desktop", eventType: "pipeline",
    summary: state === "passed" ? "passed Jenkins verification for" : state === "failed" ? `reported Jenkins ${ciStatus} for` : "cancelled Jenkins verification for",
    linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets", meta: `commit ${run.commit_sha ?? "unknown"} · build ${buildNumber ?? "unknown"}` });
  res.status(200).json({ ciStatus, retrying: ciStatus === "retrying" });
}

export async function reportJenkinsProgress(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { deviceId, buildUrl, buildNumber } = req.body ?? {};
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId) || typeof buildUrl !== "string" || buildUrl.length > 2048) {
    throw new HttpError(400, "The Jenkins progress update is invalid.");
  }
  const { data: run, error } = await supabaseAdmin.from("pipeline_runs").select("id,ticket_id,jenkins_job_url")
    .eq("id", req.params.runId).eq("project_id", req.project!.id).eq("claimed_by", deviceId).eq("status", "in_progress").maybeSingle();
  if (error || !run) throw new HttpError(409, "This Jenkins run is no longer claimed by this desktop.");
  try {
    const root = new URL(run.jenkins_job_url);
    const build = new URL(buildUrl);
    if (build.protocol !== root.protocol || build.origin !== root.origin || !build.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`)) throw new Error("outside Jenkins job");
  } catch { throw new HttpError(400, "The build link is outside the selected Jenkins job."); }
  const { error: updateError } = await supabaseAdmin.from("pipeline_runs").update({ jenkins_build_url: buildUrl,
    jenkins_build_number: Number.isInteger(buildNumber) ? buildNumber : null, updated_at: new Date().toISOString() }).eq("id", run.id);
  if (updateError) throw new HttpError(500, "Could not save the Jenkins progress update.");
  await supabaseAdmin.from("tickets").update({ ci_run_url: buildUrl }).eq("id", run.ticket_id).eq("project_id", req.project!.id);
  res.status(200).json({ accepted: true });
}

export async function cancelQueuedJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { data: ticket } = await supabaseAdmin.from("tickets").select("ci_status").eq("id", req.params.ticketId).eq("project_id", req.project!.id).maybeSingle();
  if (ticket?.ci_status === "retrying") {
    await supabaseAdmin.from("tickets").update({ ci_status: "cancelled", ci_error: "The AI retry was cancelled. Review the PR branch for any changes that were already in progress." })
      .eq("id", req.params.ticketId).eq("project_id", req.project!.id).eq("ci_status", "retrying");
    res.status(200).json({ cancelled: true }); return;
  }
  const { data: queued, error } = await supabaseAdmin.from("pipeline_runs").select("id")
    .eq("ticket_id", req.params.ticketId).eq("project_id", req.project!.id).eq("status", "queued")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new HttpError(500, "Could not inspect the queued Jenkins run.");
  if (!queued) throw new HttpError(409, "This Jenkins run has already started or finished.");
  const { data: cancelled, error: cancelError } = await supabaseAdmin.from("pipeline_runs").update({ status: "cancelled", conclusion: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", queued.id).eq("status", "queued").select("id").maybeSingle();
  if (cancelError) throw new HttpError(500, "Could not cancel the queued Jenkins run.");
  if (!cancelled) throw new HttpError(409, "This Jenkins run has already started.");
  await supabaseAdmin.from("tickets").update({ ci_status: "cancelled", ci_error: null }).eq("id", req.params.ticketId).eq("project_id", req.project!.id);
  res.status(200).json({ cancelled: true });
}
