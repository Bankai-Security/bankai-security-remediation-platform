import type { Job } from "bullmq";
import { env } from "../env.js";
import { runQuincyTriageScan } from "../lib/quincy.js";
import { securityRegression } from "../lib/security-regression.js";
import { enqueueFixRetry } from "../lib/queue.js";
import { ensureCiBootstrapReady } from "../lib/ci-bootstrap.js";
import { CI_WORKFLOW_FILE, CI_WORKFLOW_PATH } from "../lib/ci-template.js";
import {
  dispatchWorkflowRun,
  GithubApiError,
  getRepoFileContent,
  getBranchHeadSha,
  listWorkflowRuns,
  mergeBranchFromBase,
  repoFileExists,
  type WorkflowRunSummary,
} from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { hasPlaceholderChecks } from "../lib/pipeline-verdict.js";
import type { PipelineJobData } from "../lib/queue.js";
import { loadGithubCreds } from "../lib/ticketing.js";
import { supabaseAdmin } from "../lib/supabase.js";

interface PipelineTicketRow {
  id: string;
  github_branch_name: string | null;
  ci_fix_attempt: number;
  findings: PipelineFindingRow | PipelineFindingRow[] | null;
}

interface PipelineFindingRow {
  external_id: string | null;
  file_path: string | null;
  cwe: string | null;
  line_start: number | null;
  line_end: number | null;
}

// workflow_dispatch's run doesn't appear in the list-runs API instantly —
// poll briefly rather than relying solely on the workflow_run webhook,
// since that webhook never fires at all if the dispatch itself silently
// failed to queue a run (e.g. a bad ref).
const RUN_POLL_ATTEMPTS = 5;
const RUN_POLL_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setPipelineError(ticketId: string, message: string): Promise<void> {
  await supabaseAdmin.from("tickets").update({ ci_status: "failed", ci_error: message }).eq("id", ticketId);
}

// The BullMQ processor for the "ci-pipeline" queue: dispatches
// bankai-verify.yml against a ticket's remediation branch and records the
// dispatched run so webhook.controller.ts's workflow_run handler has
// something to correlate against once it completes. Same no-session,
// service-role, re-check-everything contract as fix-pr.job.ts — this may
// run more than once for the same ticket (the belt-and-suspenders dedup on
// enqueuePipelineVerification, plus every explicit "Retry CI" click via
// enqueuePipelineRetry), and every failure here is caught and recorded on
// the ticket rather than thrown, since a stuck job would otherwise
// permanently occupy the ticket's dedup slot and block its next retry.
export async function processPipelineJob(job: Job<PipelineJobData>): Promise<void> {
  const { ticketId, projectId } = job.data;
  const supabase = supabaseAdmin;

  const { data: ticketData, error: ticketError } = await supabase
    .from("tickets")
    .select("id, github_branch_name, ci_fix_attempt, findings(external_id, file_path, cwe, line_start, line_end)")
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (ticketError || !ticketData) {
    logger.error({ err: ticketError, ticketId, projectId }, "pipeline job: ticket not found");
    return;
  }
  const ticket = ticketData as PipelineTicketRow;
  if (!ticket.github_branch_name) return;

  const branch = ticket.github_branch_name;

  try {
    const github = await loadGithubCreds(supabase, projectId);
    if (!github) {
      await setPipelineError(ticketId, "GitHub is not connected. Reconnect GitHub for this project, then retry CI.");
      return;
    }
    const bootstrapReady = await ensureCiBootstrapReady(supabase, projectId, github);
    if (!bootstrapReady) {
      // Either the bootstrap PR was just opened, or one is already open —
      // either way this ticket waits for handlePullRequestEvent to
      // re-enqueue it once that PR merges (see markBootstrapPrMerged).
      await supabase.from("tickets").update({ ci_status: "pending_setup", ci_error: null }).eq("id", ticketId);
      return;
    }

    await supabase.from("tickets").update({ ci_status: "queued", ci_error: null }).eq("id", ticketId);

    // The remediation branch may have been created before bankai-verify.yml
    // landed on the default branch — every ticket that was still open when
    // the bootstrap PR merged has a branch whose own history predates the
    // file. GitHub validates workflow_dispatch's trigger against the ref
    // being dispatched, not the default branch, so dispatching straight
    // against a stale branch 422s ("Workflow does not have 'workflow_dispatch'
    // trigger"). Bring the branch up to date first — cheap no-op once it's
    // already in sync (mergeBranchFromBase 204s and every later dispatch on
    // this branch skips straight past this check).
    if (!(await repoFileExists(github.creds, CI_WORKFLOW_PATH, branch))) {
      await mergeBranchFromBase(github.creds, {
        base: branch,
        head: github.defaultBranch,
        commitMessage: "ci: sync bankai-verify.yml onto this branch",
      });
    }

    const workflow = await getRepoFileContent(github.creds, CI_WORKFLOW_PATH, branch);
    if (!workflow || hasPlaceholderChecks(workflow)) {
      await supabase.from("tickets").update({ ci_status: "pending_setup", ci_error: "Replace placeholder workflow commands with real checks on the remediation branch, then retry CI." }).eq("id", ticketId);
      return;
    }

    // Every commit, including a CI-generated repair, must remain secure.
    if (env.QUINCY_API_URL) {
      const headSha = await getBranchHeadSha(github.creds, branch);
      const baseSha = await getBranchHeadSha(github.creds, github.defaultBranch);
      const baseline = await runQuincyTriageScan({ repo: github.creds.repo, ref: baseSha, commitSha: baseSha, scoreFindings: false, githubToken: github.creds.token });
      const current = await runQuincyTriageScan({ repo: github.creds.repo, ref: headSha, commitSha: headSha, scoreFindings: false, githubToken: github.creds.token });
      if (!baseline || !current) {
        await setPipelineError(ticketId, "Quincy security verification is unavailable. Retry CI when Quincy is healthy.");
        return;
      }
      const finding = Array.isArray(ticket.findings) ? ticket.findings[0] : ticket.findings;
      const regression = securityRegression(baseline.findings, current.findings, { externalId: finding?.external_id ?? null, filePath: finding?.file_path ?? null, cwe: finding?.cwe ?? null, lineStart: finding?.line_start ?? null, lineEnd: finding?.line_end ?? null });
      if (regression) {
        await setPipelineError(ticketId, regression);
        if ((ticket.ci_fix_attempt ?? 1) < 3) {
          await enqueueFixRetry({ ticketId, projectId, githubRunId: 0, failingStage: "build", securityFeedback: regression, securityCommitSha: headSha });
        }
        return;
      }
      if (await getBranchHeadSha(github.creds, branch) !== headSha) {
        await setPipelineError(ticketId, "The PR changed during security verification. Retry CI for its latest commit.");
        return;
      }
    }

    // Exclude retained runs from older dispatches, even on the same branch.
    const previousRunIds = new Set((await listWorkflowRuns(github.creds, { workflowFile: CI_WORKFLOW_FILE, branch })).map((run) => run.id));
    await dispatchWorkflowRun(github.creds, {
      workflowFile: CI_WORKFLOW_FILE,
      ref: branch,
      inputs: { ticket_id: ticketId },
    });

    let run: WorkflowRunSummary | undefined;
    for (let attempt = 0; attempt < RUN_POLL_ATTEMPTS && !run; attempt++) {
      if (attempt > 0) await sleep(RUN_POLL_DELAY_MS);
      const runs = await listWorkflowRuns(github.creds, { workflowFile: CI_WORKFLOW_FILE, branch });
      run = runs.find((candidate) => !previousRunIds.has(candidate.id));
    }

    if (!run) {
      // Dispatch succeeded but GitHub hasn't indexed the run in the list API
      // yet — the workflow_run webhook will still correlate and record the
      // result by branch name once the run completes, so this isn't fatal.
      await supabase.from("tickets").update({ ci_status: "running" }).eq("id", ticketId);
      return;
    }

    // The workflow_run webhook may have already raced ahead of this poll —
    // the scaffold's placeholder `echo` steps can complete before this poll
    // even returns. Never insert a second row for the same run.
    const { data: existingRun } = await supabase
      .from("pipeline_runs")
      .select("id")
      .eq("ticket_id", ticketId)
      .eq("github_run_id", run.id)
      .maybeSingle();

    if (!existingRun) {
      await supabase.from("pipeline_runs").insert({
        ticket_id: ticketId,
        project_id: projectId,
        github_run_id: run.id,
        workflow_file: CI_WORKFLOW_FILE,
        head_branch: branch,
        status: run.status === "completed" ? "completed" : "in_progress",
        conclusion: run.conclusion,
        html_url: run.htmlUrl,
        started_at: new Date().toISOString(),
      });
    }

    // Guarded on still being 'queued': if the webhook already landed a
    // final passed/failed verdict while this poll was running, don't stomp
    // it back to an in-progress state.
    await supabase
      .from("tickets")
      .update({ ci_status: "running", ci_run_url: run.htmlUrl })
      .eq("id", ticketId)
      .eq("ci_status", "queued");
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not dispatch the CI verification pipeline.";
    logger.error({ err, ticketId, projectId }, "pipeline job failed");
    await setPipelineError(ticketId, message);
  }
}
