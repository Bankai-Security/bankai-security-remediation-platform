import type { Job } from "bullmq";
import { recordActivity } from "../lib/activity.js";
import { tryApplyDependencyVersionFix } from "../lib/dependency-fix.js";
import { generateFix, type FixFindingInput } from "../lib/gemini-fix.js";
import { gatherRepoContext } from "../lib/repo-context.js";
import {
  commitFileToBranch,
  compareCommits,
  createPullRequest,
  createPullRequestComment,
  getBranchHeadSha,
  getBlob,
  getPullRequest,
  getTree,
  GithubApiError,
} from "../lib/github.js";
import { transitionIssue, type JiraCredentials } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { saveRemediationProgress } from "../lib/queue.js";
import { env } from "../env.js";
import { describeQuincyFallback, parseGithubPrNumber, runQuincyRemediationWorkflow } from "../lib/quincy.js";
import { clearQuincyCheckpoint, enqueueFixPrResume, enqueuePipelineVerification, loadQuincyCheckpoint, saveQuincyCheckpoint, type FixPrJobData } from "../lib/queue.js";
import { attemptBranchCreation, loadGithubCreds, loadJiraCreds } from "../lib/ticketing.js";
import { supabaseAdmin } from "../lib/supabase.js";

interface FixPrTicketRow {
  id: string;
  key: string;
  status: string;
  github_branch_name: string | null;
  github_pr_number: number | null;
  github_pr_low_confidence: boolean;
  github_fix_commit_sha: string | null;
  jira_issue_key: string | null;
  finding_id: string;
  findings: FixPrFindingRow | FixPrFindingRow[] | null;
}

interface FixPrFindingRow {
  fingerprint: string;
  external_id: string | null;
  title: string;
  severity: string;
  source: "csv" | "github_ai" | "jira_import";
  cwe: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  description: string | null;
  rationale: string | null;
  remediation_guidance: string | null;
  finding_type: string | null;
  cves: string | null;
  affected_packages: string | null;
  current_versions: string | null;
  fixed_versions: string | null;
}

const SELECT_FIX_PR_TICKET =
  "id, key, status, github_branch_name, github_pr_number, github_pr_low_confidence, github_fix_commit_sha, jira_issue_key, finding_id, findings ( fingerprint, external_id, title, severity, source, cwe, file_path, line_start, line_end, description, rationale, remediation_guidance, finding_type, cves, affected_packages, current_versions, fixed_versions )";

async function setTicketError(ticketId: string, message: string): Promise<void> {
  await supabaseAdmin.from("tickets").update({ status: "In Progress", github_pr_error: message }).eq("id", ticketId);
}

async function maybeTransitionJira(jira: { creds: JiraCredentials } | null, issueKey: string | null, status: "In Progress" | "In Review"): Promise<void> {
  if (jira && issueKey) {
    void transitionIssue(jira.creds, issueKey, status);
  }
}

function quincyPriority(severity: string): "low" | "medium" | "high" | "critical" | null {
  const normalized = severity.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") return normalized;
  return null;
}

function buildFindingEvidence(finding: FixPrFindingRow, quincyFailure: string | null): string {
  return [
    finding.description ?? finding.rationale ?? "",
    finding.finding_type ? `Finding type: ${finding.finding_type}` : null,
    finding.cves ? `CVEs: ${finding.cves}` : null,
    finding.affected_packages ? `Affected packages: ${finding.affected_packages}` : null,
    finding.current_versions ? `Current versions: ${finding.current_versions}` : null,
    finding.fixed_versions ? `Fixed versions: ${finding.fixed_versions}` : null,
    quincyFailure ? `Previous Quincy remediation result: ${quincyFailure}` : null,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");
}

function buildRemediationGuidance(finding: FixPrFindingRow, quincyFailure: string | null): string {
  return [
    finding.remediation_guidance ?? "",
    finding.fixed_versions ? `Use fixed version ${finding.fixed_versions}.` : null,
    quincyFailure ? `Quincy handoff note: ${quincyFailure}` : null,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");
}

function compactMultiline(value: string | null | undefined, maxLength = 1600): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 20).trimEnd()}\n... truncated ...`;
}

function buildRemediationEvidenceMarkdown(input: {
  ticket: FixPrTicketRow;
  finding: FixPrFindingRow;
  branch: string;
  engine: "Quincy" | "Bankai DeepSeek" | "Bankai Gemini";
  fixSummary: string | null;
  quincyJobId?: string | null;
  quincyFailure?: string | null;
  lowConfidence?: boolean;
}): string {
  const { ticket, finding } = input;
  const evidence = compactMultiline(buildFindingEvidence(finding, input.quincyFailure ?? null));
  const guidance = compactMultiline(buildRemediationGuidance(finding, input.quincyFailure ?? null));
  const summary = compactMultiline(input.fixSummary, 900);

  return [
    "## Bankai Remediation Evidence",
    "",
    `- Ticket: ${ticket.key}`,
    `- Engine: ${input.engine}`,
    input.quincyJobId ? `- Quincy job: ${input.quincyJobId}` : null,
    `- Finding: ${finding.title}`,
    finding.external_id ? `- Rule: ${finding.external_id}` : null,
    finding.cwe ? `- CWE: ${finding.cwe}` : null,
    `- Severity: ${finding.severity}`,
    `- File: \`${finding.file_path ?? "unknown"}\``,
    finding.line_start != null ? `- Location: line ${finding.line_start}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}` : null,
    `- Branch: \`${input.branch}\``,
    input.lowConfidence ? "- Confidence: low; human review required before merge" : "- Confidence: normal; human review still required before merge",
    "",
    summary ? `### Fix Summary\n${summary}` : null,
    evidence ? `### Scanner Evidence\n${evidence}` : null,
    guidance ? `### Remediation Guidance\n${guidance}` : null,
    input.quincyFailure ? `### Quincy Handoff Notes\n${compactMultiline(input.quincyFailure, 1200)}` : null,
    "",
    "Bankai never merges automatically. Review this pull request and the changed files before merging.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

async function skipFixPr(
  ticketId: string,
  projectId: string,
  findingId: string | null,
  reason: string,
  persistMessage?: string,
): Promise<void> {
  logger.warn({ ticketId, projectId, findingId, reason }, "fix-pr job early return");
  if (persistMessage) {
    await setTicketError(ticketId, persistMessage);
  }
}

// The BullMQ processor for the "fix-pr" queue: generates an AI fix for a
// ticket's finding, commits it to the ticket's already-created remediation
// branch, and opens a pull request against the project's default branch.
// Runs with no user session (service-role client), same contract as
// repo-scan.job.ts — every query is manually scoped to project_id/ticket id
// since there's no RLS safety net here.
//
// Every early-return below is a deliberate no-op, not a failure: this job
// may run more than once for the same ticket (dedup jobId is
// belt-and-suspenders, not a hard guarantee), so it re-checks the ticket's
// own state on every run instead of trusting the caller.
export async function processFixPrJob(job: Job<FixPrJobData>): Promise<void> {
  const { ticketId, projectId } = job.data;
  const supabase = supabaseAdmin;
  logger.info(
    {
      ticketId,
      projectId,
      jobId: job.id,
      quincyConfigured: Boolean(env.QUINCY_API_URL),
    },
    "fix-pr job started",
  );

  const { data: ticketData, error: ticketError } = await supabase
    .from("tickets")
    .select(SELECT_FIX_PR_TICKET)
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (ticketError || !ticketData) {
    logger.error({ err: ticketError, ticketId, projectId }, "fix-pr job: ticket not found");
    return;
  }
  const ticket = ticketData as FixPrTicketRow;
  const finding = Array.isArray(ticket.findings) ? ticket.findings[0] : ticket.findings;
  const findingId = ticket.finding_id;

  if (ticket.status === "Done") {
    await skipFixPr(ticketId, projectId, findingId, "ticket_done");
    return;
  }
  if (ticket.github_pr_number != null) {
    await skipFixPr(ticketId, projectId, findingId, "already_has_pr");
    return;
  }
  if (!finding || !finding.file_path) {
    await skipFixPr(
      ticketId,
      projectId,
      findingId,
      "missing_finding_or_file_path",
      !finding
        ? "This ticket has no linked finding, so Quincy remediation cannot start."
        : "This finding has no file path, so Quincy remediation cannot start.",
    );
    return;
  }

  let github: Awaited<ReturnType<typeof loadGithubCreds>>;
  try {
    github = await loadGithubCreds(supabase, projectId);
  } catch (err) {
    logger.error({ err, ticketId, projectId }, "Could not decrypt GitHub credentials for remediation");
    await setTicketError(ticketId, "Stored GitHub credentials could not be read. Reconnect GitHub for this project, then retry remediation.");
    return;
  }
  if (!github) {
    await skipFixPr(
      ticketId,
      projectId,
      findingId,
      "missing_github_creds",
      "GitHub is not connected for this project, so Quincy remediation cannot start.",
    );
    return;
  }

  let jira: Awaited<ReturnType<typeof loadJiraCreds>> = null;
  try {
    jira = await loadJiraCreds(supabase, projectId);
  } catch (err) {
    logger.error({ err, ticketId, projectId }, "Could not decrypt Jira credentials; continuing remediation without Jira transitions");
  }

  let branch = ticket.github_branch_name;
  if (!branch) {
    const branchColumns = await attemptBranchCreation(
      github,
      jira?.creds ?? null,
      ticket.jira_issue_key ?? null,
      finding.fingerprint,
      finding.cwe,
      finding.file_path,
      ticket.id,
      projectId,
      ticket.key,
    );
    if (!branchColumns?.github_branch_name) {
      if (branchColumns) {
        await supabase.from("tickets").update(branchColumns).eq("id", ticketId);
      }
      await skipFixPr(
        ticketId,
        projectId,
        findingId,
        "branch_creation_failed",
        branchColumns && "github_branch_error" in branchColumns && branchColumns.github_branch_error
          ? branchColumns.github_branch_error
          : "Could not create a remediation branch.",
      );
      return;
    }
    branch = branchColumns.github_branch_name;
    await supabase
      .from("tickets")
      .update({ ...branchColumns, ci_status: null, ci_error: null, github_pr_error: null })
      .eq("id", ticketId);
  }

  // Quincy accepts a stored finding snapshot when no scanner rule is available.
  // Keep this stable so AI/CSV findings can enter the same workflow.
  const quincyRuleId = finding.external_id?.trim() || `bankai:${findingId}`;
  let quincyFailure: string | null = null;
  if (!quincyRuleId) {
    logger.warn(
      { ticketId, projectId, findingId, source: finding.source },
      "fix-pr job skipping Quincy: finding has no external_id / rule id; falling back to local fix generation",
    );
  } else {
    logger.info(
      {
        ticketId,
        projectId,
        findingId,
        ruleId: quincyRuleId,
      },
      "fix-pr job calling Quincy remediation workflow",
    );
    try {
      await saveRemediationProgress(job.data, {
        summary: "Starting Quincy remediation",
        activeAttempt: 0,
        completedAttempts: 0,
        updatedAt: new Date().toISOString(),
      }).catch(err => {
        logger.warn({ err, ticketId }, "Could not cache initial remediation progress");
      });
      const quincyResult = await runQuincyRemediationWorkflow({
        jobId: await loadQuincyCheckpoint(job.data),
        onStarted: async (jobId) => {
          await saveQuincyCheckpoint(job.data, jobId);
          await job.updateData({ ...job.data, quincyJobId: jobId });
        },
        pollTimeoutMs: 60_000,
        onProgress: progress => saveRemediationProgress(job.data, progress).catch(err => {
          logger.warn({ err, ticketId }, "Could not cache remediation progress");
        }),
        repo: github.creds.repo,
        ref: github.defaultBranch,
        ruleId: quincyRuleId,
        ticketId,
        projectId,
        severity: quincyPriority(finding.severity),
        githubToken: github.creds.token,
        baseBranch: github.defaultBranch,
        idempotencyKey: `ticket:${ticketId}:quincy-remediation:job:${job.id ?? "manual"}`,
        finding: {
          title: finding.title,
          filePath: finding.file_path,
          lineStart: finding.line_start,
          lineEnd: finding.line_end,
          cwe: finding.cwe,
          affectedPackages: finding.affected_packages,
          currentVersions: finding.current_versions,
          fixedVersions: finding.fixed_versions,
          description: finding.description ?? finding.rationale,
          remediationGuidance: finding.remediation_guidance,
        },
      });
      logger.info(
        {
          ticketId,
          projectId,
          findingId,
          ruleId: quincyRuleId,
          quincyStatus: quincyResult?.status ?? null,
          quincyJobId: quincyResult?.jobId ?? null,
          quincyPrUrl: quincyResult?.prUrl ?? null,
        },
        "fix-pr job Quincy workflow returned",
      );

      if (quincyResult) {
        if (quincyResult.status === "running") {
          await supabase.from("tickets").update({ github_pr_error: quincyResult.error }).eq("id", ticketId);
          await enqueueFixPrResume({ ...job.data, quincyJobId: quincyResult.jobId }, 30_000);
          return;
        }
        if (quincyResult.status === "succeeded" && quincyResult.prUrl) {
          const prNumber = parseGithubPrNumber(quincyResult.prUrl, github.creds.repo);
          if (!prNumber) throw new Error("Quincy returned a PR URL outside the configured repository or an invalid PR URL.");
          const pr = await getPullRequest(github.creds, prNumber);
          if (!pr || pr.state !== "open" || !pr.headRef || !pr.headSha) {
            throw new Error("Quincy's pull request could not be verified as open with a valid head commit.");
          }
          const prHead = pr.headRef;
          if ((await compareCommits(github.creds, github.defaultBranch, pr.headSha)).length === 0) {
            throw new Error("Quincy returned a pull request with no changes against the default branch.");
          }
          await supabase
            .from("tickets")
            .update({
              status: "In Review",
              github_pr_number: prNumber,
              github_pr_url: quincyResult.prUrl,
              github_pr_state: "open",
              github_branch_name: prHead,
              github_branch_url: `https://github.com/${github.creds.repo}/tree/${prHead}`,
              github_pr_low_confidence: false,
              github_pr_error: null,
              ci_status: "queued",
              ci_error: null,
            })
            .eq("id", ticketId);
          await maybeTransitionJira(jira, ticket.jira_issue_key, "In Review");
          if (prNumber) {
            const evidenceComment = buildRemediationEvidenceMarkdown({
              ticket,
              finding,
              branch: prHead,
              engine: "Quincy",
              fixSummary: quincyResult.summary,
              quincyJobId: quincyResult.jobId,
              lowConfidence: false,
            });
            const posted = await createPullRequestComment(github.creds, prNumber, evidenceComment);
            if (!posted.ok) {
              logger.error(
                { ticketId, projectId, prNumber, status: posted.status, message: posted.message },
                "Could not post Bankai evidence comment on Quincy-created PR",
              );
            }
          }
          try {
            await enqueuePipelineVerification({ ticketId, projectId });
          } catch (err) {
            logger.error({ err, ticketId, projectId }, "Could not enqueue CI verification for Quincy-created PR");
            await supabase.from("tickets").update({ ci_status: "failed", ci_error: "Could not enqueue CI verification. Check the Bankai worker and Redis." }).eq("id", ticketId);
          }
          await recordActivity(supabase, {
            projectId,
            actorId: null,
            actorLabel: "Quincy",
            eventType: "ticket",
            summary: "opened a validated remediation pull request for",
            linkTo: "tickets",
            meta: `${finding.title} · ${prNumber ? `PR #${prNumber}` : quincyResult.prUrl}`,
          });
          await clearQuincyCheckpoint(job.data, quincyResult.jobId);
          return;
        }

        if (quincyResult.status === "failed") await clearQuincyCheckpoint(job.data, quincyResult.jobId);
        const fallback = describeQuincyFallback(quincyResult);
        quincyFailure = fallback.note;
        const fallbackContext = { ticketId, projectId, ruleId: quincyRuleId, quincyFailure, quincyFallbackKind: fallback.kind };
        if (fallback.logLevel === "info") {
          logger.info(fallbackContext, fallback.logMessage);
        } else {
          logger.warn(fallbackContext, fallback.logMessage);
        }
      }
    } catch (err) {
      quincyFailure = err instanceof Error ? err.message : "Quincy remediation workflow failed.";
      logger.warn({ err, ticketId, projectId, ruleId: quincyRuleId }, "Quincy remediation workflow failed; falling back to local fix path");
    }
  }
  if (env.QUINCY_API_URL && !env.QUINCY_ALLOW_FALLBACK) {
    await setTicketError(ticketId, `Quincy validation did not produce a pull request. ${quincyFailure ?? "The engine was unavailable or returned no validated PR."} Retry remediation after resolving the engine error.`);
    return;
  }
  const findingInput: FixFindingInput = {
    title: finding.title,
    cwe: finding.cwe,
    filePath: finding.file_path,
    lineStart: finding.line_start,
    lineEnd: finding.line_end,
    evidence: buildFindingEvidence(finding, quincyFailure),
    remediationGuidance: buildRemediationGuidance(finding, quincyFailure),
  };

  try {
    let headSha = await getBranchHeadSha(github.creds, branch);

    // Resume path: a previous run already committed the fix but failed
    // before opening the PR — skip straight to PR creation instead of
    // generating (and committing) a second fix.
    const alreadyCommitted = ticket.github_fix_commit_sha != null && ticket.github_fix_commit_sha === headSha;

    // On resume the fix object is gone, so the flag persisted at commit time
    // is the only record of the committed fix's confidence.
    let lowConfidence = ticket.github_pr_low_confidence;
    let lowConfidenceSummary: string | null = null;
    let fixSummary: string | null = null;

    if (!alreadyCommitted) {
      // Safety check: never overwrite work a human already pushed to this
      // branch. An empty remediation branch has zero diff against the
      // default branch; any diff here means someone (human or a previous,
      // unrelated push) already committed to it.
      const diff = await compareCommits(github.creds, github.defaultBranch, branch);
      if (diff.length > 0) {
        await setTicketError(
          ticketId,
          "This branch already has commits — skipping the automatic fix to avoid overwriting existing work.",
        );
        return;
      }

      const tree = await getTree(github.creds, branch);
      const entry = tree.find((e) => e.path === finding.file_path);
      if (!entry) {
        await setTicketError(ticketId, `"${finding.file_path}" no longer exists on this branch.`);
        return;
      }
      const fileContent = await getBlob(github.creds, entry.sha);

      const repoContext = await gatherRepoContext({
        creds: github.creds,
        ref: branch,
        targetFilePath: finding.file_path,
        vulnerableFileContent: fileContent,
      });

      const deterministicFix = tryApplyDependencyVersionFix({
        filePath: finding.file_path,
        fileContent,
        title: finding.title,
        affectedPackages: finding.affected_packages,
        fixedVersions: finding.fixed_versions,
      });
      const fix = deterministicFix
        ? { confident: true, fixedContent: deterministicFix.fixedContent, summary: deterministicFix.summary, filesToUpdate: undefined }
        : await generateFix(findingInput, fileContent, undefined, repoContext.formattedPromptContext);
      if (!fix || fix.fixedContent === fileContent) {
        await setTicketError(ticketId, "Could not generate an automatic fix for this finding.");
        return;
      }
      // A low-confidence fix still becomes a PR — flagged so the human
      // reviewer decides whether to merge it — rather than being dropped.
      lowConfidence = !fix.confident;
      lowConfidenceSummary = lowConfidence ? fix.summary : null;
      fixSummary = fix.summary;

      // filesToUpdate is model-provided and not guaranteed disjoint from the
      // main file — the main file's fixedContent always wins on a collision.
      const extraFiles = (fix.filesToUpdate ?? []).filter((f) => f.filePath !== finding.file_path);
      const filesToCommit = [{ path: finding.file_path, content: fix.fixedContent }, ...extraFiles.map((f) => ({ path: f.filePath, content: f.fixedContent }))];

      const { commitSha } = await commitFileToBranch(github.creds, {
        branch,
        baseSha: headSha,
        message: `fix: ${finding.title}\n\n${fix.summary}\n\nAutomatically generated by Bankai for ${finding.cwe ?? "this"} finding.`,
        files: filesToCommit,
      });

      await supabase
        .from("tickets")
        .update({ status: "In Progress", github_fix_commit_sha: commitSha, github_pr_low_confidence: lowConfidence, github_pr_error: null })
        .eq("id", ticketId);
      await maybeTransitionJira(jira, ticket.jira_issue_key, "In Progress");

      headSha = commitSha;
    }

    const lowConfidenceWarning = lowConfidence
      ? `\n\n⚠️ **Low-confidence fix** — Bankai was not fully certain this change is correct and complete. ${
          lowConfidenceSummary ? `Bankai's note: ${lowConfidenceSummary}\n\n` : ""
        }Review with extra care before merging.`
      : "";
    const evidenceBody = buildRemediationEvidenceMarkdown({
      ticket,
      finding,
      branch,
      engine: env.AI_PROVIDER === "openrouter" ? "Bankai DeepSeek" : "Bankai Gemini",
      fixSummary: alreadyCommitted ? "A previous Bankai run already committed this fix; this run resumed at pull-request creation." : fixSummary,
      quincyFailure,
      lowConfidence,
    });

    const pr = await createPullRequest(github.creds, {
      head: branch,
      base: github.defaultBranch,
      title: `${lowConfidence ? "Fix (low confidence)" : "Fix"}: ${finding.title}`,
      body: `Automatically generated fix for a Bankai finding (${finding.cwe ?? "no CWE"}) in \`${finding.file_path}\`.\n\nA human must review and merge this pull request — Bankai never merges automatically.${lowConfidenceWarning}\n\n${evidenceBody}`,
    });

    await supabase
      .from("tickets")
      .update({
        status: "In Review",
        github_pr_number: pr.number,
        github_pr_url: pr.url,
        github_pr_state: "open",
        github_pr_error: null,
      })
      .eq("id", ticketId);
    await maybeTransitionJira(jira, ticket.jira_issue_key, "In Review");

    try {
      await enqueuePipelineVerification({ ticketId, projectId });
    } catch (err) {
      logger.error({ err, ticketId, projectId }, "Could not enqueue the CI verification pipeline");
      await supabase.from("tickets").update({ ci_status: "failed", ci_error: "Could not enqueue CI verification. Check the Bankai worker and Redis." }).eq("id", ticketId);
    }

    await recordActivity(supabase, {
      projectId,
      actorId: null,
      actorLabel: "Bankai AI",
      eventType: "ticket",
      summary: "opened a pull request for",
      linkTo: "tickets",
      meta: `${finding.title} · PR #${pr.number}`,
    });
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not generate and open a fix pull request.";
    logger.error({ err, ticketId, projectId }, "fix-pr job failed");
    await setTicketError(ticketId, message);
  }
}
