import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { recordActivity } from "../lib/activity.js";
import { requireRole } from "../lib/roles.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { enqueueJenkinsRetry } from "../lib/queue.js";
import { publishJenkinsEvidence } from "../lib/jenkins-evidence.js";

const MAX_RETRIES = 2;
const JENKINS_AUDIT_ACTIONS = {
  connected: "connected Jenkins credentials on Bankai Desktop",
  disconnected: "disconnected Jenkins from Bankai Desktop",
  ci_job_selected: "selected a Jenkins build job",
  cd_enabled: "enabled Jenkins deployment for a repository",
  cd_disabled: "disabled Jenkins deployment for a repository",
  cd_job_selected: "selected a Jenkins deployment job",
  manual_build_started: "started a manual Jenkins build",
} as const;

export async function recordJenkinsAuditAction(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const action = req.body?.action as keyof typeof JENKINS_AUDIT_ACTIONS;
  if (typeof action !== "string" || !Object.hasOwn(JENKINS_AUDIT_ACTIONS, action)) throw new HttpError(400, "The Jenkins audit event is invalid.");
  await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: req.user!.email ?? "Bankai user",
    eventType: "pipeline", summary: JENKINS_AUDIT_ACTIONS[action], linkTo: "tickets" });
  res.status(200).json({ recorded: true });
}

const redact = (value: string) => value
  .replace(/(password|token|secret|authorization|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]")
  .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
  .slice(0, 12_000);

function validateJenkinsJobUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new HttpError(400, "A Jenkins job from the connected server is required.");
  try {
    const url = new URL(value);
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || !url.pathname.includes("/job/")) throw new Error("invalid Jenkins job URL");
    url.search = ""; url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { throw new HttpError(400, "The Jenkins job address is invalid."); }
}

function jobBelongsToSelection(selectedJobUrl: string, actualJobUrl: string): boolean {
  try {
    const selected = new URL(selectedJobUrl);
    const actual = new URL(actualJobUrl);
    if (selected.origin !== actual.origin || selected.protocol !== actual.protocol) return false;
    const selectedPath = selected.pathname.replace(/\/+$/, "");
    const actualPath = actual.pathname.replace(/\/+$/, "");
    if (actualPath === selectedPath || actualPath.startsWith(`${selectedPath}/job/`)) return true;
    const selectedParent = selectedPath.match(/^(.*\/job\/)[^/]+$/)?.[1];
    const actualParent = actualPath.match(/^(.*\/job\/)[^/]+$/)?.[1];
    return Boolean(selectedParent && actualParent && selectedParent === actualParent);
  } catch { return false; }
}

function buildBelongsToJob(jobUrl: string, buildUrl: string): boolean {
  try {
    const job = new URL(jobUrl);
    const build = new URL(buildUrl);
    const jobPath = job.pathname.replace(/\/+$/, "");
    return build.origin === job.origin && build.protocol === job.protocol && build.pathname.startsWith(`${jobPath}/`);
  } catch { return false; }
}

async function markJenkinsNeedsReview(projectId: string, run: { id: string; ticket_id: string; pull_request_number: number }, message: string, buildUrl?: string | null, jobUrl?: string): Promise<void> {
  const now = new Date().toISOString();
  const safeMessage = redact(message).slice(0, 1500);
  const { data: changed, error } = await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "needs_review", failure_summary: safeMessage,
    jenkins_job_url: jobUrl,
    html_url: buildUrl ?? undefined, completed_at: now, updated_at: now }).eq("id", run.id).eq("status", "in_progress").select("id").maybeSingle();
  if (error) throw new HttpError(500, "Could not save the Jenkins recovery state.");
  if (!changed) {
    const { data: current } = await supabaseAdmin.from("pipeline_runs").select("status").eq("id", run.id).maybeSingle();
    if (current?.status !== "needs_review") throw new HttpError(409, "This Jenkins run has already finished and needs no recovery update.");
  }
  await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_run_url: buildUrl ?? undefined, ci_error: safeMessage })
    .eq("id", run.ticket_id).eq("project_id", projectId);
  await recordActivity(supabaseAdmin, { projectId, actorId: null, actorLabel: "Bankai Desktop", eventType: "pipeline",
    summary: "marked Jenkins verification for as needing review", linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets", meta: safeMessage });
  await publishJenkinsEvidence(projectId, run.ticket_id);
}

export async function claimJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const deviceId = req.body?.deviceId;
  const jobUrl = req.body?.jobUrl;
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId)) {
    throw new HttpError(400, "A desktop ID and selected Jenkins job are required.");
  }
  const selectedJobUrl = validateJenkinsJobUrl(jobUrl);
  const { data: verificationSettings, error: settingsError } = await supabaseAdmin.from("projects")
    .select("verification_provider").eq("id", req.project!.id).maybeSingle();
  if (settingsError) throw new HttpError(500, "Could not load the selected CI provider.");
  if (verificationSettings?.verification_provider !== "jenkins") { res.status(204).end(); return; }
  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: staleRuns } = await supabaseAdmin.from("pipeline_runs").update({ status: "needs_review", conclusion: "desktop_disconnected",
    failure_summary: "Bankai Desktop stopped reporting before this build finished. Check Jenkins before retrying.", completed_at: new Date().toISOString() })
    .eq("project_id", req.project!.id).eq("status", "in_progress").lt("claimed_at", staleBefore).select("ticket_id");
  for (const stale of staleRuns ?? []) {
    await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai Desktop stopped reporting before this build finished. Check Jenkins before retrying." })
      .eq("id", stale.ticket_id).eq("project_id", req.project!.id);
    await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: null, actorLabel: "Bankai Desktop recovery", eventType: "pipeline",
      summary: "marked a stale Jenkins build for review on", linkTo: "tickets" });
  }
  for (const ticketId of new Set((staleRuns ?? []).map((run) => run.ticket_id))) await publishJenkinsEvidence(req.project!.id, ticketId);
  const deploymentStaleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: staleDeployments } = await supabaseAdmin.from("pipeline_runs").update({ deployment_status: "needs_review",
    deployment_error: "Bankai Desktop stopped reporting before the deployment finished. Check Jenkins before retrying.", deployment_completed_at: new Date().toISOString() })
    .eq("project_id", req.project!.id).eq("deployment_status", "running").lt("deployment_started_at", deploymentStaleBefore).select("ticket_id");
  for (const stale of staleDeployments ?? []) {
    await supabaseAdmin.from("tickets").update({ cd_status: "needs_review", cd_error: "Bankai Desktop stopped reporting before the deployment finished. Check Jenkins before retrying." })
      .eq("id", stale.ticket_id).eq("project_id", req.project!.id);
    await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: null, actorLabel: "Bankai Desktop recovery", eventType: "pipeline",
      summary: "marked a stale Jenkins deployment for review on", linkTo: "tickets" });
  }
  for (const ticketId of new Set((staleDeployments ?? []).map((run) => run.ticket_id))) await publishJenkinsEvidence(req.project!.id, ticketId);
  const { data: activeRun, error: activeError } = await supabaseAdmin.from("pipeline_runs").select("*")
    .eq("project_id", req.project!.id).eq("status", "in_progress").eq("claimed_by", deviceId)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (activeError) throw new HttpError(500, "Could not check for a Jenkins run to resume.");
  if (activeRun) {
    res.status(200).json({ runId: activeRun.id, ticketId: activeRun.ticket_id, commitSha: activeRun.commit_sha, branch: activeRun.head_branch,
      pullRequestNumber: activeRun.pull_request_number, retryCount: activeRun.retry_count, jobUrl: activeRun.jenkins_job_url || selectedJobUrl,
      resume: true, buildUrl: activeRun.jenkins_build_url ?? null, buildNumber: activeRun.jenkins_build_number ?? null,
      manualRetry: false, buildSearchSince: activeRun.claimed_at ?? activeRun.created_at });
    return;
  }
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
    jenkins_job_url: selectedJobUrl, updated_at: new Date().toISOString(), manual_retry_requested: false,
  }).eq("id", queued.id).eq("status", "queued").select("*").maybeSingle();
  if (claimError) throw new HttpError(500, "Could not claim Jenkins work.");
  if (!claimed) { res.status(204).end(); return; }
  await supabaseAdmin.from("tickets").update({ ci_status: "running", ci_error: null }).eq("id", claimed.ticket_id).eq("project_id", req.project!.id);
  await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai Desktop", eventType: "pipeline",
    summary: "started Jenkins verification for", linkLabel: `PR #${claimed.pull_request_number}`, linkTo: "tickets", meta: `commit ${claimed.commit_sha}` });
  res.status(200).json({ runId: claimed.id, ticketId: claimed.ticket_id, commitSha: claimed.commit_sha, branch: claimed.head_branch,
    pullRequestNumber: claimed.pull_request_number, retryCount: claimed.retry_count, jobUrl: selectedJobUrl,
    manualRetry: queued.manual_retry_requested === true,
    buildSearchSince: queued.manual_retry_requested === true ? undefined : queued.updated_at ?? queued.created_at });
}

export async function finishJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { runId } = req.params;
  const { deviceId, state, buildUrl, buildNumber, commitSha, failureLog, jobUrl } = req.body ?? {};
  const states = ["passed", "failed", "cancelled", "needs_review"];
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId) || typeof state !== "string" || !states.includes(state)
    || (state !== "needs_review" && (typeof buildUrl !== "string" || buildUrl.length > 2048))
    || (buildUrl != null && (typeof buildUrl !== "string" || buildUrl.length > 2048))) {
    throw new HttpError(400, "The Jenkins result is incomplete or invalid.");
  }
  const { data: run, error: loadError } = await supabaseAdmin.from("pipeline_runs").select("*").eq("id", runId)
    .eq("project_id", req.project!.id).eq("claimed_by", deviceId).maybeSingle();
  if (loadError || !run) throw new HttpError(409, "This Jenkins run is no longer claimed by this desktop.");
  if (run.status !== "in_progress") {
    if ((run.status === "completed" && run.conclusion === state && (!buildUrl || run.html_url === buildUrl))
      || (run.status === "needs_review" && state === "needs_review")) {
      const { data: ticket } = await supabaseAdmin.from("tickets").select("ci_status").eq("id", run.ticket_id).maybeSingle();
      res.status(200).json({ ciStatus: ticket?.ci_status ?? state, retrying: ticket?.ci_status === "retrying" }); return;
    }
    throw new HttpError(409, "This Jenkins run has already finished or been reviewed.");
  }
  const safeJobUrl = jobUrl == null ? run.jenkins_job_url : validateJenkinsJobUrl(jobUrl);
  if (!jobBelongsToSelection(run.jenkins_job_url, safeJobUrl)) throw new HttpError(400, "The Jenkins job is outside the selected multibranch job.");
  if (state === "needs_review") {
    const message = typeof failureLog === "string" ? failureLog : "Bankai could not confirm the Jenkins result. Check Jenkins before retrying to avoid starting duplicate work.";
    const safeBuildUrl = typeof buildUrl === "string" ? validateJenkinsJobUrl(buildUrl) : null;
    if (safeBuildUrl && safeBuildUrl !== safeJobUrl && !buildBelongsToJob(safeJobUrl, safeBuildUrl)) throw new HttpError(400, "The Jenkins link is outside the selected job.");
    await markJenkinsNeedsReview(req.project!.id, run, message, safeBuildUrl, safeJobUrl);
    res.status(200).json({ ciStatus: "needs_review", retrying: false }); return;
  }
  const validBuildUrl = validateJenkinsJobUrl(buildUrl);
  try {
    const root = new URL(safeJobUrl);
    const build = new URL(validBuildUrl);
    const rootPath = root.pathname.replace(/\/$/, "");
    if (!(["https:", "http:"].includes(build.protocol)) || build.origin !== root.origin || !(build.pathname === rootPath || build.pathname.startsWith(`${rootPath}/`))) throw new Error("outside selected Jenkins job");
  } catch {
    throw new HttpError(400, "The build link is outside the selected Jenkins job.");
  }
  if (commitSha && run.commit_sha && commitSha.toLowerCase() !== run.commit_sha.toLowerCase()) {
    await markJenkinsNeedsReview(req.project!.id, run, "Jenkins built a different commit than the remediation PR.", validBuildUrl, safeJobUrl);
    res.status(200).json({ ciStatus: "needs_review", retrying: false }); return;
  }
  if (!commitSha && state !== "cancelled") {
    await markJenkinsNeedsReview(req.project!.id, run, "Jenkins did not report a commit SHA, so Bankai cannot verify this build matches the PR.", validBuildUrl, safeJobUrl);
    res.status(200).json({ ciStatus: "needs_review", retrying: false }); return;
  }
  if (commitSha && !/^[0-9a-f]{40}$/i.test(commitSha)) {
    await markJenkinsNeedsReview(req.project!.id, run, "Jenkins did not report a full commit SHA, so Bankai cannot verify this build matches the PR.", validBuildUrl, safeJobUrl);
    res.status(200).json({ ciStatus: "needs_review", retrying: false }); return;
  }
  const log = typeof failureLog === "string" ? redact(failureLog) : "";
  const summary = state === "failed" ? (log.split(/\r?\n/).filter(Boolean).slice(-8).join("\n").slice(0, 1500) || "Jenkins reported a failed build.") : null;
  const now = new Date().toISOString();
  const { data: savedRun, error } = await supabaseAdmin.from("pipeline_runs").update({ status: "completed", conclusion: state, html_url: validBuildUrl, jenkins_job_url: safeJobUrl,
    jenkins_build_number: Number.isInteger(buildNumber) ? buildNumber : null, completed_at: now, updated_at: now, failure_summary: summary })
    .eq("id", run.id).eq("status", "in_progress").select("id").maybeSingle();
  if (error) throw new HttpError(500, "Could not save the Jenkins result.");
  if (!savedRun) throw new HttpError(409, "A duplicate Jenkins result was already processed for this run.");

  let ciStatus = state === "passed" ? "passed" : state === "cancelled" ? "cancelled" : "failed";
  const eligible = state === "failed"
    && /(test|assert|compil|lint|checkstyle|build failed|failed to compile|failure:|error:)/i.test(log)
    && !/(401|403|credential|permission|authentication|agent offline|connection refused|timed? out|no space left|jenkins.*unavailable|setup:|configuration|branch discovery|no matching)/i.test(log);
  if (eligible && run.retry_count < MAX_RETRIES) {
    await supabaseAdmin.from("tickets").update({ ci_status: "retrying", ci_run_url: validBuildUrl, ci_error: summary })
      .eq("id", run.ticket_id).eq("project_id", req.project!.id);
    try {
      await enqueueJenkinsRetry({ ticketId: run.ticket_id, projectId: req.project!.id, runId: run.id, retryCount: run.retry_count + 1, failureLog: log });
      ciStatus = "retrying";
      await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai AI", eventType: "pipeline",
        summary: "queued a targeted Jenkins remediation retry for", linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets", meta: `retry ${run.retry_count + 1}` });
    } catch {
      ciStatus = "needs_review";
    }
  } else if (state === "failed" && (run.retry_count >= MAX_RETRIES || !eligible)) ciStatus = "needs_review";
  const ciError = ciStatus === "needs_review" ? (eligible ? "The automatic retry limit was reached. Review the Jenkins build and update the pull request." : "Jenkins failed for a setup or environment reason. Fix the Jenkins configuration, then review the pull request.") : summary;
  if (ciStatus !== "retrying") await supabaseAdmin.from("tickets").update({ ci_status: ciStatus, ci_run_url: validBuildUrl, ci_error: ciError }).eq("id", run.ticket_id).eq("project_id", req.project!.id);
  if (ciStatus !== "retrying") await publishJenkinsEvidence(req.project!.id, run.ticket_id);
  await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai Desktop", eventType: "pipeline",
    summary: state === "passed" ? "passed Jenkins verification for" : state === "failed" ? `reported Jenkins ${ciStatus} for` : "cancelled Jenkins verification for",
    linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets", meta: `commit ${run.commit_sha ?? "unknown"} · build ${buildNumber ?? "unknown"}` });
  res.status(200).json({ ciStatus, retrying: ciStatus === "retrying" });
}

export async function reportJenkinsProgress(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { deviceId, buildUrl, buildNumber, jobUrl } = req.body ?? {};
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId) || typeof buildUrl !== "string" || buildUrl.length > 2048) {
    throw new HttpError(400, "The Jenkins progress update is invalid.");
  }
  const { data: run, error } = await supabaseAdmin.from("pipeline_runs").select("id,ticket_id,jenkins_job_url")
    .eq("id", req.params.runId).eq("project_id", req.project!.id).eq("claimed_by", deviceId).eq("status", "in_progress").maybeSingle();
  if (error || !run) throw new HttpError(409, "This Jenkins run is no longer claimed by this desktop.");
  const safeJobUrl = jobUrl == null ? run.jenkins_job_url : validateJenkinsJobUrl(jobUrl);
  if (!jobBelongsToSelection(run.jenkins_job_url, safeJobUrl)) throw new HttpError(400, "The Jenkins job is outside the selected multibranch job.");
  const safeBuildUrl = validateJenkinsJobUrl(buildUrl);
  try {
    const root = new URL(safeJobUrl);
    const build = new URL(safeBuildUrl);
    if (build.protocol !== root.protocol || build.origin !== root.origin || !build.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`)) throw new Error("outside Jenkins job");
  } catch { throw new HttpError(400, "The build link is outside the selected Jenkins job."); }
  const { error: updateError } = await supabaseAdmin.from("pipeline_runs").update({ jenkins_job_url: safeJobUrl, jenkins_build_url: safeBuildUrl,
    jenkins_build_number: Number.isInteger(buildNumber) ? buildNumber : null, updated_at: new Date().toISOString() }).eq("id", run.id);
  if (updateError) throw new HttpError(500, "Could not save the Jenkins progress update.");
  await supabaseAdmin.from("tickets").update({ ci_run_url: safeBuildUrl }).eq("id", run.ticket_id).eq("project_id", req.project!.id);
  res.status(200).json({ accepted: true });
}

export async function reportJenkinsDeployment(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { deviceId, state, jobUrl, buildUrl, buildNumber, targetUrl, error: suppliedError } = req.body ?? {};
  if (typeof deviceId !== "string" || !/^[\w.-]{8,100}$/.test(deviceId)
    || !["running", "passed", "failed", "needs_review", "cancelled"].includes(state)) {
    throw new HttpError(400, "The Jenkins deployment update is invalid.");
  }
  const { data: run, error: loadError } = await supabaseAdmin.from("pipeline_runs").select("id,ticket_id,commit_sha,conclusion,claimed_by,jenkins_job_url,deployment_job_url,deployment_build_url,deployment_status,pull_request_number")
    .eq("id", req.params.runId).eq("project_id", req.project!.id).eq("claimed_by", deviceId).maybeSingle();
  if (loadError || !run || run.conclusion !== "passed" || !run.commit_sha) throw new HttpError(409, "Deployment is only available after the matching Jenkins build passes.");
  const { data: ticket, error: ticketLoadError } = await supabaseAdmin.from("tickets").select("github_pr_state,github_pr_number").eq("id", run.ticket_id).eq("project_id", req.project!.id).maybeSingle();
  if (ticketLoadError || ticket?.github_pr_state !== "open" || ticket.github_pr_number !== run.pull_request_number) throw new HttpError(409, "Deployment is only available while the verified remediation pull request is open.");
  if (run.deployment_status === state && state !== "running" && (!buildUrl || run.deployment_build_url === buildUrl)) {
    res.status(200).json({ cdStatus: state, duplicate: true }); return;
  }
  if (state === "running" && jobUrl) {
    const selectedJob = validateJenkinsJobUrl(jobUrl);
    try {
      const ciJob = new URL(run.jenkins_job_url);
      const deployJob = new URL(selectedJob);
      if (deployJob.origin !== ciJob.origin || deployJob.protocol !== ciJob.protocol || !deployJob.pathname.includes("/job/")) throw new Error("deployment job is outside the Jenkins server");
    } catch { throw new HttpError(400, "Select a deployment job from the connected Jenkins server."); }
    if (run.deployment_status == null) {
      const { data: started, error } = await supabaseAdmin.from("pipeline_runs").update({ deployment_status: "running", deployment_job_url: selectedJob,
        deployment_started_at: new Date().toISOString(), deployment_error: null }).eq("id", run.id).eq("conclusion", "passed").is("deployment_status", null).select("id").maybeSingle();
      if (error) throw new HttpError(500, "Could not start deployment tracking.");
      if (!started) throw new HttpError(409, "A deployment was already started for this pull request commit.");
      await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai Desktop", eventType: "pipeline",
        summary: "started a Jenkins deployment for", linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets" });
    } else if (run.deployment_status !== "running" || run.deployment_job_url !== selectedJob) {
      throw new HttpError(409, "A different deployment is already recorded for this pull request commit.");
    }
  } else if (state === "needs_review" && run.deployment_status == null) {
    const { data: updated, error } = await supabaseAdmin.from("pipeline_runs").update({ deployment_status: "needs_review", deployment_job_url: jobUrl ?? null,
      deployment_started_at: new Date().toISOString() }).eq("id", run.id).is("deployment_status", null).select("id").maybeSingle();
    if (error) throw new HttpError(500, "Could not save the deployment recovery state.");
    if (!updated) throw new HttpError(409, "A deployment update was already recorded.");
  } else if (run.deployment_status !== "running") throw new HttpError(409, "This deployment is not running.");

  let safeTargetUrl: string | null = null;
  if (targetUrl != null) {
    try {
      const target = new URL(targetUrl);
      if (target.protocol !== "https:" || target.username || target.password) throw new Error("unsafe target URL");
      target.search = ""; target.hash = "";
      safeTargetUrl = target.toString();
    } catch { throw new HttpError(400, "Jenkins returned an invalid deployment target link."); }
  }
  let safeBuildUrl: string | null = null;
  if (buildUrl != null) {
    safeBuildUrl = validateJenkinsJobUrl(buildUrl);
    try {
      const root = new URL(run.deployment_job_url);
      const build = new URL(safeBuildUrl);
      const rootPath = root.pathname.replace(/\/$/, "");
      if (build.origin !== root.origin || build.protocol !== root.protocol || !(build.pathname === rootPath || build.pathname.startsWith(`${rootPath}/`))) throw new Error("build URL outside deployment job");
    } catch { throw new HttpError(400, "The deployment build link is outside the selected Jenkins job."); }
  }
  const finalState = state === "running" ? "running" : state;
  const finalError = typeof suppliedError === "string" ? redact(suppliedError).slice(0, 1500) : null;
  const finished = finalState !== "running";
  const { error: updateError } = await supabaseAdmin.from("pipeline_runs").update({ deployment_status: finalState,
    deployment_build_url: safeBuildUrl ?? undefined, deployment_build_number: Number.isInteger(buildNumber) ? buildNumber : undefined,
    deployment_target_url: safeTargetUrl, deployment_error: finalError, deployment_completed_at: finished ? new Date().toISOString() : undefined })
    .eq("id", run.id);
  if (updateError) throw new HttpError(500, "Could not save the deployment result.");
  const { error: ticketError } = await supabaseAdmin.from("tickets").update({ cd_status: finalState,
    cd_run_url: safeBuildUrl ?? (state === "running" ? null : undefined), cd_error: finalError, cd_target_url: safeTargetUrl }).eq("id", run.ticket_id).eq("project_id", req.project!.id);
  if (ticketError) throw new HttpError(500, "Could not update the ticket deployment status.");
  if (finished) await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: "Bankai Desktop", eventType: "pipeline",
    summary: `${finalState === "passed" ? "completed" : finalState === "failed" ? "failed" : finalState === "cancelled" ? "cancelled" : "could not confirm"} Jenkins deployment for`,
    linkLabel: `PR #${run.pull_request_number}`, linkTo: "tickets", meta: Number.isInteger(buildNumber) ? `build ${buildNumber}` : null });
  await publishJenkinsEvidence(req.project!.id, run.ticket_id);
  res.status(200).json({ cdStatus: finalState });
}

export async function cancelQueuedJenkinsRun(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const ticketId = Array.isArray(req.params.ticketId) ? req.params.ticketId[0] : req.params.ticketId;
  if (!ticketId) throw new HttpError(400, "A ticket ID is required.");
  const { data: ticket } = await supabaseAdmin.from("tickets").select("ci_status").eq("id", ticketId).eq("project_id", req.project!.id).maybeSingle();
  if (ticket?.ci_status === "retrying") {
    await supabaseAdmin.from("tickets").update({ ci_status: "cancelled", ci_error: "The AI retry was cancelled. Review the PR branch for any changes that were already in progress." })
      .eq("id", ticketId).eq("project_id", req.project!.id).eq("ci_status", "retrying");
    await publishJenkinsEvidence(req.project!.id, ticketId);
    res.status(200).json({ cancelled: true }); return;
  }
  const { data: queued, error } = await supabaseAdmin.from("pipeline_runs").select("id")
    .eq("ticket_id", ticketId).eq("project_id", req.project!.id).eq("status", "queued")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new HttpError(500, "Could not inspect the queued Jenkins run.");
  if (!queued) throw new HttpError(409, "This Jenkins run has already started or finished.");
  const { data: cancelled, error: cancelError } = await supabaseAdmin.from("pipeline_runs").update({ status: "cancelled", conclusion: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", queued.id).eq("status", "queued").select("id").maybeSingle();
  if (cancelError) throw new HttpError(500, "Could not cancel the queued Jenkins run.");
  if (!cancelled) throw new HttpError(409, "This Jenkins run has already started.");
  await supabaseAdmin.from("tickets").update({ ci_status: "cancelled", ci_error: null }).eq("id", ticketId).eq("project_id", req.project!.id);
  await publishJenkinsEvidence(req.project!.id, ticketId);
  res.status(200).json({ cancelled: true });
}

export async function retryJenkinsVerification(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { data: verification } = await supabaseAdmin.from("projects").select("verification_provider")
    .eq("id", req.project!.id).maybeSingle();
  if (verification?.verification_provider !== "jenkins") {
    throw new HttpError(409, "Manual verification retries are available only when Jenkins is the selected provider.");
  }
  const ticketId = Array.isArray(req.params.ticketId) ? req.params.ticketId[0] : req.params.ticketId;
  if (!ticketId) throw new HttpError(400, "A ticket ID is required.");

  const { data: ticket, error: ticketError } = await supabaseAdmin.from("tickets")
    .select("id,ci_status,github_pr_number,github_pr_state,github_fix_commit_sha")
    .eq("id", ticketId).eq("project_id", req.project!.id).maybeSingle();
  if (ticketError) throw new HttpError(500, "Could not load the remediation pull request.");
  if (!ticket) throw new HttpError(404, "Ticket not found.");
  if (ticket.ci_status !== "needs_review" && ticket.ci_status !== "failed") throw new HttpError(409, "Only a failed Jenkins verification can be retried.");
  if (ticket.github_pr_state !== "open" || !ticket.github_pr_number) throw new HttpError(409, "The remediation pull request must still be open to retry verification.");

  const { data: active, error: activeError } = await supabaseAdmin.from("pipeline_runs").select("id")
    .eq("ticket_id", ticketId).eq("project_id", req.project!.id).in("status", ["queued", "in_progress"]).limit(1).maybeSingle();
  if (activeError) throw new HttpError(500, "Could not check for an active Jenkins run.");
  if (active) throw new HttpError(409, "A Jenkins verification is already queued or running for this ticket.");

  const { data: run, error: runError } = await supabaseAdmin.from("pipeline_runs").select("id,commit_sha,pull_request_number")
    .eq("ticket_id", ticketId).eq("project_id", req.project!.id).in("status", ["needs_review", "completed"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (runError) throw new HttpError(500, "Could not load the Jenkins run for retry.");
  if (!run || !run.commit_sha || !ticket.github_fix_commit_sha || run.commit_sha.toLowerCase() !== ticket.github_fix_commit_sha.toLowerCase()
    || run.pull_request_number !== ticket.github_pr_number) {
    throw new HttpError(409, "Bankai cannot safely retry this run because its pull request commit could not be verified.");
  }

  const now = new Date().toISOString();
  const { data: queued, error: queueError } = await supabaseAdmin.from("pipeline_runs").update({
    status: "queued", conclusion: null, claimed_by: null, claimed_at: null, started_at: null, completed_at: null,
    jenkins_job_url: null, html_url: null, jenkins_build_url: null, jenkins_build_number: null, failure_summary: null, updated_at: now,
    manual_retry_requested: true,
  }).eq("id", run.id).in("status", ["needs_review", "completed"]).select("id").maybeSingle();
  if (queueError) throw new HttpError(500, "Could not queue the Jenkins verification retry.");
  if (!queued) throw new HttpError(409, "This Jenkins run changed before the retry could be queued.");

  const { error: updateTicketError } = await supabaseAdmin.from("tickets").update({ ci_status: "queued", ci_error: null, ci_run_url: null })
    .eq("id", ticketId).eq("project_id", req.project!.id).in("ci_status", ["needs_review", "failed"]);
  if (updateTicketError) throw new HttpError(500, "The Jenkins retry was queued, but the ticket status could not be updated.");
  await recordActivity(supabaseAdmin, { projectId: req.project!.id, actorId: req.user!.id, actorLabel: req.user!.email ?? "Bankai user",
    eventType: "pipeline", summary: "queued a manual Jenkins verification retry for", linkLabel: `PR #${ticket.github_pr_number}`, linkTo: "tickets" });
  res.status(202).json({ queued: true });
}
