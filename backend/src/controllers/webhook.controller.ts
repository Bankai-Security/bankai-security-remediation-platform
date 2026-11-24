import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { decrypt } from "../lib/crypto.js";
import { enqueueRepoScan } from "../lib/queue.js";
import { getPullRequest, upsertHostedCiEvidenceComment } from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  loadGithubCreds,
  markTicketPrClosedWithoutMerge,
  markTicketPrMerged,
} from "../lib/ticketing.js";

interface WebhookProjectRow {
  github_repo: string | null;
  github_default_branch: string | null;
  github_webhook_secret_enc: string | null;
  github_connected_at: string | null;
  verification_provider?: string | null;
  ci_bootstrap_status?: string | null;
  ci_bootstrap_pr_url?: string | null;
}

interface GithubPushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
}

interface GithubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    merged?: boolean;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
    base?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  };
}

interface GithubWorkflowRunPayload {
  action?: string;
  workflow?: { path?: string };
  workflow_run?: {
    id?: number;
    event?: string;
    head_branch?: string;
    head_sha?: string;
    html_url?: string;
    status?: string;
    conclusion?: string | null;
    run_started_at?: string | null;
    updated_at?: string | null;
    pull_requests?: Array<{ number?: number }>;
  };
}

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  // timingSafeEqual throws on length mismatch rather than returning false —
  // guard explicitly so a wrong-length header can't crash the request.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// No requireAuth/originCheck/session in this path — GitHub calls this
// directly, server-to-server, with no cookie and (usually) no Origin
// header. The HMAC signature against this project's own webhook secret is
// the entire trust boundary here; every branch below fails closed.
export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    // Would mean express.raw() wasn't applied to this route — a wiring bug,
    // not something a real request from GitHub could trigger.
    res.status(400).end();
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("github_repo, github_default_branch, github_webhook_secret_enc, github_connected_at, verification_provider, ci_bootstrap_status, ci_bootstrap_pr_url")
    .eq("id", projectId)
    .maybeSingle();

  const project = data as WebhookProjectRow | null;
  if (error || !project || !project.github_connected_at || !project.github_webhook_secret_enc) {
    res.status(404).end();
    return;
  }

  const secret = decrypt(project.github_webhook_secret_enc);
  if (!verifySignature(secret, rawBody, req.get("x-hub-signature-256"))) {
    logger.warn({ projectId }, "GitHub webhook signature verification failed");
    res.status(401).end();
    return;
  }

  const event = req.get("x-github-event");
  if (event === "ping") {
    res.status(200).json({ ok: true });
    return;
  }
  if (event === "pull_request") {
    await handlePullRequestEvent(projectId, project, rawBody, res);
    return;
  }
  if (event === "workflow_run") {
    await handleWorkflowRunEvent(projectId, project, rawBody, res);
    return;
  }
  if (event !== "push") {
    res.status(200).json({ ignored: true });
    return;
  }

  let payload: GithubPushPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPushPayload;
  } catch {
    res.status(400).end();
    return;
  }

  const branch = (payload.ref ?? "").replace(/^refs\/heads\//, "");

  // Never scan pushes to the bot's own remediation branches — creating
  // tickets from a scan can itself lead to pushes on remediation/*
  // branches, and re-scanning those would be pointless busywork at best
  // and a feedback loop at worst.
  if (branch.startsWith("remediation/")) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (!project.github_default_branch || branch !== project.github_default_branch) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (payload.deleted) {
    res.status(200).json({ ignored: true });
    return;
  }

  const eventKey = payload.after ? `push:${branch}:${payload.after}` : null;
  let { data: scan, error: scanError } = await supabaseAdmin
    .from("scans")
    .insert({
      project_id: projectId,
      source: "github_ai",
      status: "Queued",
      trigger_type: "webhook",
      scan_type: "push",
      branch,
      commit_sha: payload.after ?? null,
      event_key: eventKey,
    })
    .select("id")
    .maybeSingle();

  if (scanError?.code === "23505" && eventKey) {
    ({ data: scan, error: scanError } = await supabaseAdmin.from("scans").select("id").eq("project_id", projectId).eq("event_key", eventKey).maybeSingle());
  }

  if (scanError || !scan) {
    logger.error({ err: scanError, projectId }, "Could not record a scan row for a GitHub webhook push");
    res.status(500).end();
    return;
  }

  await enqueueRepoScan(
    { scanId: scan.id, projectId, triggerType: "webhook", ...(payload.after ? { headSha: payload.after } : {}) },
    `webhook-${projectId}-${payload.after ?? `${branch}-${Date.now()}`}`,
  );

  // GitHub enforces a short response timeout on webhook deliveries and
  // marks them failed/retries otherwise — the scan itself runs in the
  // worker, never in this request.
  res.status(202).json({ queued: true });
}

// Signature verification already happened in handleGithubWebhook before this
// is called — same trust boundary as the push handling above.
async function handlePullRequestEvent(projectId: string, project: WebhookProjectRow, rawBody: Buffer, res: Response): Promise<void> {
  let payload: GithubPullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPullRequestPayload;
  } catch {
    res.status(400).end();
    return;
  }

  if (typeof payload.number !== "number") {
    res.status(200).json({ ignored: true });
    return;
  }

  if (["opened", "reopened", "synchronize"].includes(payload.action ?? "")) {
    const pr = payload.pull_request;
    const headSha = pr?.head?.sha;
    const baseSha = pr?.base?.sha;
    const branch = pr?.head?.ref;
    const headRepo = pr?.head?.repo?.full_name;
    if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha) || !project.github_default_branch || !project.github_repo
      || pr?.base?.ref !== project.github_default_branch || pr.base.repo?.full_name?.toLowerCase() !== project.github_repo.toLowerCase()
      || !headRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(headRepo)
      || !branch) {
      res.status(200).json({ ignored: true });
      return;
    }

    const eventKey = `pr:${payload.number}:${headSha}`;
    let { data: scan, error } = await supabaseAdmin.from("scans").insert({
      project_id: projectId,
      source: "github_ai",
      status: "Queued",
      trigger_type: "webhook",
      scan_type: "pull_request",
      branch,
      commit_sha: headSha,
      base_commit_sha: baseSha ?? null,
      pull_request_number: payload.number,
      event_key: eventKey,
    }).select("id").maybeSingle();
    if (error?.code === "23505") {
      ({ data: scan, error } = await supabaseAdmin.from("scans").select("id").eq("project_id", projectId).eq("event_key", eventKey).maybeSingle());
    }
    if (error || !scan) {
      logger.error({ err: error, projectId, prNumber: payload.number }, "Could not record a GitHub pull request scan");
      res.status(500).end();
      return;
    }
    try {
      await enqueueRepoScan(
        { scanId: scan.id, projectId, triggerType: "webhook", scanType: "pull_request", pullRequestNumber: payload.number, headSha, ...(baseSha ? { baseSha } : {}), headRepo },
        `pr-${projectId}-${payload.number}-${headSha}`,
      );
    } catch (err) {
      logger.error({ err, projectId, prNumber: payload.number, headSha }, "Could not enqueue GitHub pull request scan");
      res.status(503).end();
      return;
    }
    // A remediation PR can receive additional commits after Bankai opens it
    // (for example, a user fixes the Jenkinsfile). Keep the Jenkins run
    // pinned to the PR's latest exact head so successful newer builds can be
    // verified without accepting evidence for an older revision.
    if (payload.action === "synchronize" && (project.verification_provider === "jenkins"
      || (project.verification_provider === "hosted_ci" && project.ci_bootstrap_status === "ready"))) {
      const github = await loadGithubCreds(supabaseAdmin, projectId);
      if (!github) {
        logger.error({ projectId, prNumber: payload.number }, "Cannot reconcile the synchronized Jenkins PR without GitHub credentials");
        res.status(503).end();
        return;
      }
      let currentPr;
      try { currentPr = await getPullRequest(github.creds, payload.number); }
      catch (err) {
        logger.error({ err, projectId, prNumber: payload.number }, "Could not verify the current GitHub PR head for Jenkins");
        res.status(503).end();
        return;
      }
      // Webhook deliveries may arrive out of order. Always reconcile against
      // GitHub's live PR head, never a stale synchronize payload.
      const currentHeadSha = currentPr?.headSha;
      if (!currentPr || currentPr.state !== "open" || currentPr.headRef !== branch
        || !currentHeadSha || !/^[0-9a-f]{40}$/i.test(currentHeadSha)) {
        res.status(202).json({ queued: true, scanType: "pull_request", pullRequestNumber: payload.number, headSha });
        return;
      }
      const { data: ticket, error: ticketError } = await supabaseAdmin.from("tickets")
        .select("id,github_branch_name,github_fix_commit_sha")
        .eq("project_id", projectId).eq("github_pr_number", payload.number).eq("github_pr_state", "open")
        .maybeSingle();
      if (ticketError) {
        logger.error({ err: ticketError, projectId, prNumber: payload.number }, "Could not load the remediation ticket for an updated PR");
        res.status(500).end();
        return;
      }
      if (ticket && ticket.github_branch_name === branch) {
        const now = new Date().toISOString();
        if (ticket.github_fix_commit_sha?.toLowerCase() !== currentHeadSha.toLowerCase()) {
          let updateTicketQuery = supabaseAdmin.from("tickets").update({
            github_fix_commit_sha: currentHeadSha, ci_status: "queued", ci_error: null, ci_run_url: null,
          }).eq("id", ticket.id).eq("project_id", projectId).eq("github_pr_state", "open");
          updateTicketQuery = ticket.github_fix_commit_sha
            ? updateTicketQuery.eq("github_fix_commit_sha", ticket.github_fix_commit_sha)
            : updateTicketQuery.is("github_fix_commit_sha", null);
          const { data: updatedTicket, error: updateError } = await updateTicketQuery.select("id").maybeSingle();
          if (updateError) {
            logger.error({ err: updateError, projectId, ticketId: ticket.id }, "Could not update the Jenkins remediation commit");
            res.status(500).end();
            return;
          }
          if (updatedTicket) {
            await supabaseAdmin.from("pipeline_runs").update({ status: "cancelled", conclusion: "superseded", completed_at: now, updated_at: now })
              .eq("ticket_id", ticket.id).eq("project_id", projectId).neq("commit_sha", currentHeadSha).in("status", ["queued", "in_progress"]);
          } else {
            const { data: currentTicket, error: currentTicketError } = await supabaseAdmin.from("tickets").select("github_fix_commit_sha")
              .eq("id", ticket.id).eq("project_id", projectId).maybeSingle();
            if (currentTicketError) {
              logger.error({ err: currentTicketError, projectId, ticketId: ticket.id }, "Could not confirm the remediation commit after a concurrent update");
              res.status(500).end();
              return;
            }
            if (currentTicket?.github_fix_commit_sha?.toLowerCase() !== currentHeadSha.toLowerCase()) {
              res.status(202).json({ queued: true, scanType: "pull_request", pullRequestNumber: payload.number, headSha });
              return;
            }
          }
        }
        if (project.verification_provider === "jenkins") {
          // Ensure the run exists on repeated webhook deliveries too. This
          // repairs partial failures where the ticket SHA update succeeded but
          // the run insert failed and GitHub retried the same event.
          let { data: run, error: runError } = await supabaseAdmin.from("pipeline_runs").select("status,conclusion,failure_summary")
            .eq("ticket_id", ticket.id).eq("project_id", projectId).eq("commit_sha", currentHeadSha).maybeSingle();
          if (!run && !runError) {
            const { error: queueError } = await supabaseAdmin.from("pipeline_runs").upsert({
              ticket_id: ticket.id, project_id: projectId, workflow_file: "Jenkinsfile", head_branch: branch,
              commit_sha: currentHeadSha, pull_request_number: payload.number, retry_count: 0, status: "queued", updated_at: now,
            }, { onConflict: "ticket_id,commit_sha", ignoreDuplicates: true });
            if (queueError) {
              logger.error({ err: queueError, projectId, ticketId: ticket.id, headSha: currentHeadSha }, "Could not queue Jenkins verification for the updated PR");
              await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai could not queue Jenkins verification. Retry from the ticket after checking Jenkins." })
                .eq("id", ticket.id).eq("project_id", projectId).eq("github_fix_commit_sha", currentHeadSha);
              res.status(500).end();
              return;
            }
            ({ data: run, error: runError } = await supabaseAdmin.from("pipeline_runs").select("status,conclusion,failure_summary")
              .eq("ticket_id", ticket.id).eq("project_id", projectId).eq("commit_sha", currentHeadSha).maybeSingle());
          }
          if (runError || !run) {
            logger.error({ err: runError, projectId, ticketId: ticket.id, headSha: currentHeadSha }, "Could not confirm Jenkins verification was queued");
            await supabaseAdmin.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai could not confirm Jenkins verification was queued. Retry from the ticket." })
              .eq("id", ticket.id).eq("project_id", projectId).eq("github_fix_commit_sha", currentHeadSha);
            res.status(500).end();
            return;
          }
          const ciStatus = run.status === "queued" ? "queued" : run.status === "in_progress" ? "running"
            : run.status === "needs_review" ? "needs_review" : run.status === "cancelled" ? "cancelled"
              : run.conclusion === "passed" ? "passed" : run.conclusion === "failed" ? "failed"
                : run.conclusion === "cancelled" ? "cancelled" : "needs_review";
          await supabaseAdmin.from("tickets").update({ ci_status: ciStatus,
            ci_error: ciStatus === "needs_review" ? run.failure_summary ?? "The existing Jenkins run needs review." : null,
          }).eq("id", ticket.id).eq("project_id", projectId).eq("github_fix_commit_sha", currentHeadSha);
        }
      }
    }
    if (project.verification_provider === "hosted_ci") {
      if (payload.action === "reopened" && project.ci_bootstrap_status === "ready") {
        const { data: ticket } = await supabaseAdmin.from("tickets").select("id")
          .eq("project_id", projectId).eq("github_pr_number", payload.number).maybeSingle();
        if (ticket) await supabaseAdmin.from("tickets").update({ ci_status: "needs_review",
          ci_error: "This pull request was reopened without a new commit. Review the existing run or push a new commit to trigger verification." })
          .eq("id", ticket.id).eq("project_id", projectId);
      }
    }
    res.status(202).json({ queued: true, scanType: "pull_request", pullRequestNumber: payload.number, headSha });
    return;
  }

  if (payload.action !== "closed") {
    res.status(200).json({ ignored: true });
    return;
  }

  const bootstrapPrNumber = project.ci_bootstrap_pr_url?.match(/\/pull\/(\d+)(?:\D|$)/)?.[1];
  if (bootstrapPrNumber && Number(bootstrapPrNumber) === payload.number && project.ci_bootstrap_status === "pr_open") {
    const merged = payload.pull_request?.merged === true;
    await supabaseAdmin.from("projects").update({
      ci_bootstrap_status: merged ? "ready" : "none",
      ci_bootstrap_pr_url: merged ? project.ci_bootstrap_pr_url : null,
      ...(merged ? {} : { verification_provider: "none" }),
    }).eq("id", projectId);
    if (!merged) {
      await supabaseAdmin.from("tickets").update({ ci_status: "pending_setup", ci_error: "The hosted CI setup pull request was closed without merging." })
        .eq("project_id", projectId).eq("github_pr_state", "open");
    }
  }

  if (payload.pull_request?.merged) {
    await markTicketPrMerged(supabaseAdmin, { projectId, prNumber: payload.number });
  } else {
    await markTicketPrClosedWithoutMerge(supabaseAdmin, { projectId, prNumber: payload.number });
  }

  res.status(200).json({ ok: true });
}

async function handleWorkflowRunEvent(projectId: string, project: WebhookProjectRow, rawBody: Buffer, res: Response): Promise<void> {
  let payload: GithubWorkflowRunPayload;
  try { payload = JSON.parse(rawBody.toString("utf8")) as GithubWorkflowRunPayload; }
  catch { res.status(400).end(); return; }
  const run = payload.workflow_run;
  if (project.verification_provider !== "hosted_ci" || project.ci_bootstrap_status !== "ready"
    || payload.workflow?.path !== ".github/workflows/bankai-verify.yml" || run?.event !== "pull_request"
    || !Number.isSafeInteger(run.id) || !run.head_sha || !/^[0-9a-f]{40}$/i.test(run.head_sha)
    || !run.head_branch || !run.html_url || !["requested", "in_progress", "completed"].includes(payload.action ?? "")) {
    res.status(200).json({ ignored: true });
    return;
  }

  let runUrl: URL;
  try {
    runUrl = new URL(run.html_url);
    if (runUrl.protocol !== "https:" || runUrl.hostname.toLowerCase() !== "github.com" || runUrl.username || runUrl.password) throw new Error("invalid");
    runUrl.search = ""; runUrl.hash = "";
  } catch { res.status(200).json({ ignored: true }); return; }

  const workflowStatus = payload.action === "completed" ? "completed" : payload.action === "in_progress" ? "in_progress" : "queued";
  const pullRequests = (run.pull_requests ?? []).map((pr) => pr.number).filter((n): n is number => Number.isInteger(n) && Number(n) > 0);
  if (!pullRequests.length) { res.status(200).json({ ignored: true }); return; }

  const github = await loadGithubCreds(supabaseAdmin, projectId);
  if (!github) { res.status(200).json({ ignored: true }); return; }
  let conclusion: "passed" | "failed" | "cancelled" | "needs_review" | null = null;
  if (workflowStatus === "completed") {
    conclusion = run.conclusion === "success" ? "passed"
      : run.conclusion === "cancelled" ? "cancelled"
        : run.conclusion === "failure" || run.conclusion === "timed_out" ? "failed" : "needs_review";
  }

  for (const prNumber of new Set(pullRequests)) {
    const { data: prior } = await supabaseAdmin.from("hosted_ci_runs").select("status")
      .eq("project_id", projectId).eq("github_run_id", run.id).eq("pull_request_number", prNumber).maybeSingle();
    if (prior?.status === "completed" && workflowStatus !== "completed") continue;

    const { data: ticket } = await supabaseAdmin.from("tickets").select("id,github_fix_commit_sha")
      .eq("project_id", projectId).eq("github_pr_number", prNumber).maybeSingle();
    const exactTicketCommit = !ticket || (!!ticket.github_fix_commit_sha && ticket.github_fix_commit_sha.toLowerCase() === run.head_sha.toLowerCase());
    const reportedConclusion = ticket && !exactTicketCommit ? "needs_review" : conclusion;
    const startedAt = run.run_started_at && !Number.isNaN(Date.parse(run.run_started_at)) ? run.run_started_at : null;
    const completedAt = workflowStatus === "completed" && run.updated_at && !Number.isNaN(Date.parse(run.updated_at)) ? run.updated_at : null;
    const { error: saveError } = await supabaseAdmin.from("hosted_ci_runs").upsert({
      project_id: projectId,
      github_run_id: run.id,
      pull_request_number: prNumber,
      head_branch: run.head_branch,
      commit_sha: run.head_sha,
      status: workflowStatus,
      conclusion: reportedConclusion,
      html_url: runUrl.toString(),
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "project_id,github_run_id,pull_request_number" });
    if (saveError) {
      logger.error({ err: saveError, projectId, githubRunId: run.id }, "Could not save hosted CI run evidence");
      res.status(500).end();
      return;
    }

    if (ticket && exactTicketCommit) {
      const ciStatus = reportedConclusion ?? (workflowStatus === "queued" ? "queued" : "running");
      const message = reportedConclusion === "needs_review" ? "GitHub Actions completed without a recognized conclusion. Review the run manually." : null;
      await supabaseAdmin.from("tickets").update({ ci_status: ciStatus, ci_run_url: runUrl.toString(), ci_error: message })
        .eq("id", ticket.id).eq("project_id", projectId).eq("github_fix_commit_sha", run.head_sha);
    }

    const statusLabel = reportedConclusion === "passed" ? "Passed"
      : reportedConclusion === "failed" ? "Failed"
        : reportedConclusion === "cancelled" ? "Cancelled"
          : reportedConclusion === "needs_review" ? "Needs review"
            : workflowStatus === "in_progress" ? "Running" : "Queued";
    const markdown = [
      "## Bankai hosted CI evidence",
      "",
      `- **Pull request:** #${prNumber}`,
      `- **Commit:** \`${run.head_sha}\``,
      `- **GitHub Actions:** ${statusLabel} · [View workflow run](${runUrl.toString()})`,
      `- **Updated:** ${completedAt ?? startedAt ?? new Date().toISOString()}`,
      "",
      "Review the result and pull request changes before merging. Bankai does not merge pull requests.",
    ].join("\n");
    try { await upsertHostedCiEvidenceComment(github.creds, prNumber, markdown); }
    catch (err) { logger.warn({ err, projectId, prNumber, githubRunId: run.id }, "Could not publish hosted CI evidence to the pull request"); }
  }

  res.status(202).json({ recorded: true, githubRunId: run.id });
}
