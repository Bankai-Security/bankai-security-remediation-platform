import type { Job } from "bullmq";
import { recordActivity } from "../lib/activity.js";
import { loadPythonDependencyContext, tryApplyDependencyVersionFix } from "../lib/dependency-fix.js";
import { generateFix, generatedFixPathsAreInScope, isSafePatchPath, normalizeRepositoryFilePath, type FixFindingInput } from "../lib/gemini-fix.js";
import { gatherRepoContext } from "../lib/repo-context.js";
import {
  commitFileToBranch,
  compareCommits,
  createPullRequest,
  getBranchHeadSha,
  getBlob,
  getTree,
  GithubApiError,
} from "../lib/github.js";
import { transitionIssue, type JiraCredentials } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import type { FixPrJobData } from "../lib/queue.js";
import { findingStillPresent } from "../lib/finding-revalidation.js";
import { scanRepository } from "../lib/scanners.js";
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
  component: string | null;
  cwe: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  description: string | null;
  rationale: string | null;
  remediation_guidance: string | null;
  fix_available: string | null;
  finding_type: string | null;
  cves: string | null;
  affected_packages: string | null;
  current_versions: string | null;
  fixed_versions: string | null;
}

const SELECT_FIX_PR_TICKET =
  "id, key, status, github_branch_name, github_pr_number, github_pr_low_confidence, github_fix_commit_sha, jira_issue_key, finding_id, findings ( fingerprint, external_id, title, severity, source, component, cwe, file_path, line_start, line_end, description, rationale, remediation_guidance, fix_available, finding_type, cves, affected_packages, current_versions, fixed_versions )";

async function setTicketError(ticketId: string, message: string): Promise<void> {
  await supabaseAdmin.from("tickets").update({ status: "In Progress", github_pr_error: message }).eq("id", ticketId);
}

async function maybeTransitionJira(jira: { creds: JiraCredentials } | null, issueKey: string | null, status: "In Progress" | "In Review"): Promise<void> {
  if (jira && issueKey) {
    void transitionIssue(jira.creds, issueKey, status);
  }
}

function buildFindingEvidence(finding: FixPrFindingRow): string {
  return [
    finding.description ?? finding.rationale ?? "",
    finding.finding_type ? `Finding type: ${finding.finding_type}` : null,
    finding.cves ? `CVEs: ${finding.cves}` : null,
    finding.affected_packages || finding.component ? `Affected packages: ${finding.affected_packages ?? finding.component}` : null,
    finding.current_versions ? `Current versions: ${finding.current_versions}` : null,
    finding.fixed_versions ? `Fixed versions: ${finding.fixed_versions}` : null,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");
}

function buildRemediationGuidance(finding: FixPrFindingRow): string {
  return [
    finding.remediation_guidance ?? "",
    finding.fixed_versions || finding.fix_available ? `Use fixed version ${finding.fixed_versions ?? finding.fix_available}.` : null,
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
  targetFilePath: string;
  engine: "Bankai DeepSeek" | "Bankai Gemini";
  fixSummary: string | null;
  lowConfidence?: boolean;
}): string {
  const { ticket, finding } = input;
  const evidence = compactMultiline(buildFindingEvidence(finding));
  const guidance = compactMultiline(buildRemediationGuidance(finding));
  const summary = compactMultiline(input.fixSummary, 900);

  return [
    "## Bankai Remediation Evidence",
    "",
    `- Ticket: ${ticket.key}`,
    `- Engine: ${input.engine}`,
    `- Finding: ${finding.title}`,
    finding.external_id ? `- Rule: ${finding.external_id}` : null,
    finding.cwe ? `- CWE: ${finding.cwe}` : null,
    `- Severity: ${finding.severity}`,
    `- File: \`${input.targetFilePath}\``,
    finding.line_start != null ? `- Location: line ${finding.line_start}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}` : null,
    `- Branch: \`${input.branch}\``,
    input.lowConfidence ? "- Confidence: low; human review required before merge" : "- Confidence: normal; human review still required before merge",
    "",
    summary ? `### Fix Summary\n${summary}` : null,
    evidence ? `### Scanner Evidence\n${evidence}` : null,
    guidance ? `### Remediation Guidance\n${guidance}` : null,
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
        ? "This ticket has no linked finding, so remediation cannot start."
        : "This finding has no file path, so remediation cannot start.",
    );
    return;
  }
  let targetFilePath = normalizeRepositoryFilePath(finding.file_path);
  if (!isSafePatchPath(targetFilePath)) {
    await setTicketError(ticketId, "The finding target is not a safe repository-relative path; no remediation was attempted.");
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
      "GitHub is not connected for this project, so remediation cannot start.",
    );
    return;
  }

  // Findings can go stale between the original scan and a queued remediation
  // run. Re-run the configured scanner set against the current default branch
  // before creating or modifying a remediation branch. This shared preflight
  // applies to every language/scanner Bankai runs, not just dependency audits.
  let currentBranchSha: string;
  try {
    currentBranchSha = await getBranchHeadSha(github.creds, github.defaultBranch);
  } catch (err) {
    logger.error({ err, ticketId, projectId }, "Could not read the current default branch before remediation");
    await setTicketError(ticketId, "Could not read the current default branch. No remediation changes were made; retry after GitHub is available.");
    return;
  }
  const scannerName = finding.finding_type?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const configuredScanners = new Set(["trivy", "semgrep", "gitleaks", "bandit", "npm-audit", "pip-audit", "osv"]);
  if (scannerName && configuredScanners.has(scannerName)) {
    let currentScan: Awaited<ReturnType<typeof scanRepository>>;
    try {
      currentScan = await scanRepository(github.creds, currentBranchSha);
    } catch (err) {
      logger.error({ err, ticketId, projectId }, "Could not revalidate the finding against the current default branch");
      await setTicketError(ticketId, "Could not verify this finding against the current default branch. No remediation changes were made; retry after the repository scan is available.");
      return;
    }
    const scannerRun = currentScan.scanners.find((run) => run.scanner.toLowerCase().replace(/[\s_]+/g, "-") === scannerName);
    if (!scannerRun || scannerRun.status === "failed") {
      await setTicketError(ticketId, scannerRun?.reason
        ? `Could not verify this finding because ${scannerRun.scanner} failed: ${scannerRun.reason}`
        : `Could not verify this finding because scanner "${finding.finding_type}" did not run. No remediation changes were made.`);
      return;
    }
    const storedFinding = {
      fingerprint: finding.fingerprint,
      externalId: finding.external_id,
      title: finding.title,
      component: finding.component,
      affectedPackages: finding.affected_packages,
      filePath: finding.file_path,
      findingType: finding.finding_type,
      description: finding.description,
      cves: finding.cves,
    };
    const rescannedFindings = currentScan.findings.map((item) => ({
      fingerprint: item.fingerprint,
      externalId: item.externalId,
      title: item.title,
      component: item.component,
      filePath: item.filePath,
      findingType: item.findingType,
      description: item.description,
      cves: item.cves,
    }));
    if (!findingStillPresent(storedFinding, rescannedFindings)) {
      // A completed scanner run against the live default-branch head is
      // positive evidence that this ticket is stale. Resolve it here so a
      // normal retry doesn't leave users with an unrecoverable scanner error.
      try {
        if (await getBranchHeadSha(github.creds, github.defaultBranch) === currentBranchSha) {
          const { error: findingError } = await supabaseAdmin.from("findings")
            .update({ bucket: "Resolved", rationale: `Not detected by ${scannerRun.scanner} in a complete scan of the current default branch (${currentBranchSha.slice(0, 8)}).` })
            .eq("id", findingId)
            .eq("project_id", projectId);
          if (findingError) throw findingError;
          const { error: ticketError } = await supabaseAdmin.from("tickets")
            .update({ status: "Done", github_pr_state: "resolved_externally", github_pr_error: null })
            .eq("id", ticketId)
            .eq("project_id", projectId);
          if (ticketError) throw ticketError;
          const jira = await loadJiraCreds(supabaseAdmin, projectId);
          if (jira && ticket.jira_issue_key) await transitionIssue(jira.creds, ticket.jira_issue_key, "Done");
          logger.info({ ticketId, findingId, scanner: scannerRun.scanner, commitSha: currentBranchSha }, "Resolved stale ticket from current default-branch scan evidence");
          return;
        }
      } catch (err) {
        logger.error({ err, ticketId, findingId }, "Could not auto-resolve a finding absent from the current default branch");
      }
      await setTicketError(
        ticketId,
        `This finding was not detected by ${scannerRun.scanner} on the current default branch (${currentBranchSha.slice(0, 8)}). Bankai could not verify the same branch head at completion, so no changes were made; retry after the scan completes.`,
      );
      return;
    }
  } else {
    // Manual/CSV findings and imported scanner types without an executable
    // scanner still need a valid current-branch file target.
    try {
      const tree = await getTree(github.creds, currentBranchSha);
      if (!tree.some((entry) => entry.type === "blob" && entry.path === targetFilePath)) {
        await setTicketError(ticketId, `The finding target "${targetFilePath}" is not present on the current default branch. No remediation changes were made; rescan or update the finding location before retrying.`);
        return;
      }
    } catch (err) {
      logger.error({ err, ticketId, projectId }, "Could not validate the finding target against the current default branch");
      await setTicketError(ticketId, "Could not validate the finding target against the current default branch. No remediation changes were made; retry after GitHub is available.");
      return;
    }
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
      targetFilePath,
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
      .update({ ...branchColumns, github_pr_error: null })
      .eq("id", ticketId);
  }

  const findingInput: FixFindingInput = {
    title: finding.title,
    cwe: finding.cwe,
    filePath: targetFilePath,
    lineStart: finding.line_start,
    lineEnd: finding.line_end,
    evidence: buildFindingEvidence(finding),
    remediationGuidance: buildRemediationGuidance(finding),
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

      // Pin every read and the eventual commit to the exact branch revision
      // observed before generation; the mutable branch name is not a baseline.
      const baseSha = headSha;
      const tree = await getTree(github.creds, baseSha);
      let entry = tree.find((e) => e.path === targetFilePath);
      // Older pip-audit findings used the package name (for example,
      // "idna") as file_path. Resolve those legacy records to the source
      // requirements manifest before giving up on remediation.
      if (!entry && finding.finding_type === "pip-audit") {
        const requirementFiles = tree
          .filter((item) => item.type === "blob" && /(^|\/)requirements(?:[-\w]*)?\.txt$/i.test(item.path))
          .map((item) => item.path);
        const preferred = requirementFiles.includes("requirements.txt")
          ? "requirements.txt"
          : requirementFiles.length === 1 ? requirementFiles[0] : null;
        if (preferred) {
          targetFilePath = preferred;
          entry = tree.find((item) => item.path === preferred);
        }
      }
      if (!entry) {
        await setTicketError(ticketId, finding.finding_type === "pip-audit"
          ? `Could not identify the requirements file for package finding "${finding.file_path}" on this branch.`
          : `"${targetFilePath}" no longer exists on this branch.`);
        return;
      }
      const fileContent = await getBlob(github.creds, entry.sha);

      const repoContext = await gatherRepoContext({
        creds: github.creds,
        ref: baseSha,
        targetFilePath,
        vulnerableFileContent: fileContent,
      });
      const dependencyContext = finding.finding_type === "pip-audit"
        ? await loadPythonDependencyContext({
            filePath: targetFilePath,
            fileContent,
            title: finding.title,
            affectedPackages: finding.affected_packages ?? finding.component,
          })
        : "";

      const deterministicFix = tryApplyDependencyVersionFix({
        filePath: targetFilePath,
        fileContent,
        title: finding.title,
        affectedPackages: finding.affected_packages ?? finding.component,
        fixedVersions: finding.fixed_versions ?? finding.fix_available,
      });
      const fix = deterministicFix
        ? { confident: true, fixedContent: deterministicFix.fixedContent, summary: deterministicFix.summary, filesToUpdate: undefined }
        : await generateFix(findingInput, fileContent, `${repoContext.formattedPromptContext}${dependencyContext}`);
      if (!fix || fix.fixedContent === fileContent) {
        await setTicketError(ticketId, "Could not generate an automatic fix for this finding.");
        return;
      }
      const suppliedContextPaths = new Set([
        ...repoContext.importedFiles.map((file) => file.path),
        ...repoContext.testFiles.map((file) => file.path),
      ]);
      if (!generatedFixPathsAreInScope(fix, targetFilePath, suppliedContextPaths)) {
        await setTicketError(ticketId, "The generated patch included an invalid or out-of-scope repository path; no changes were committed.");
        return;
      }
      // A low-confidence fix still becomes a PR — flagged so the human
      // reviewer decides whether to merge it — rather than being dropped.
      lowConfidence = !fix.confident;
      lowConfidenceSummary = lowConfidence ? fix.summary : null;
      fixSummary = fix.summary;

      // filesToUpdate is model-provided and not guaranteed disjoint from the
      // main file — the main file's fixedContent always wins on a collision.
      const extraFiles = (fix.filesToUpdate ?? []).filter((f) => f.filePath !== targetFilePath);
      const filesToCommit = [{ path: targetFilePath, content: fix.fixedContent }, ...extraFiles.map((f) => ({ path: f.filePath, content: f.fixedContent }))];

      const { commitSha } = await commitFileToBranch(github.creds, {
        branch,
        baseSha,
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
      targetFilePath,
      engine: env.AI_PROVIDER === "openrouter" ? "Bankai DeepSeek" : "Bankai Gemini",
      fixSummary: alreadyCommitted ? "A previous Bankai run already committed this fix; this run resumed at pull-request creation." : fixSummary,
      lowConfidence,
    });

    // Finding titles may contain the full advisory text (some feed entries
    // are several paragraphs long). GitHub rejects PR titles over its limit;
    // keep the title concise while preserving the complete finding in the PR
    // body above.
    const titlePrefix = lowConfidence ? "Fix (low confidence): " : "Fix: ";
    const fullPrTitle = `${titlePrefix}${finding.title}`;
    const titleCharacters = Array.from(fullPrTitle);
    const prTitle = titleCharacters.length > 240
      ? `${titleCharacters.slice(0, 239).join("").trimEnd()}…`
      : fullPrTitle;

    const pr = await createPullRequest(github.creds, {
      head: branch,
      base: github.defaultBranch,
      title: prTitle,
      body: `Automatically generated fix for a Bankai finding (${finding.cwe ?? "no CWE"}) in \`${targetFilePath}\`.\n\nA human must review and merge this pull request — Bankai never merges automatically.${lowConfidenceWarning}\n\n${evidenceBody}`,
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
    if (headSha) {
      const { data: verification } = await supabase.from("projects").select("verification_provider,ci_bootstrap_status").eq("id", projectId).maybeSingle();
      if (verification?.verification_provider === "jenkins") {
        const { error: pipelineError } = await supabase.from("pipeline_runs").upsert({
          ticket_id: ticketId, project_id: projectId, workflow_file: "Jenkinsfile", head_branch: branch,
          commit_sha: headSha, pull_request_number: pr.number, status: "queued", retry_count: 0,
        }, { onConflict: "ticket_id,commit_sha", ignoreDuplicates: true });
        if (pipelineError) {
          logger.error({ err: pipelineError, ticketId, projectId }, "Could not queue Jenkins verification for remediation PR");
          await supabase.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai could not queue Jenkins verification. Retry verification from the ticket after checking the Jenkins connection." })
            .eq("id", ticketId).eq("project_id", projectId).eq("github_fix_commit_sha", headSha);
        } else {
          // An idempotent insert may have found a run for this exact commit.
          // Preserve its real state rather than claiming work is queued when
          // the only matching run already completed or was cancelled.
          const { data: run, error: runError } = await supabase.from("pipeline_runs").select("status,conclusion")
            .eq("ticket_id", ticketId).eq("project_id", projectId).eq("commit_sha", headSha).maybeSingle();
          if (runError || !run) {
            logger.error({ err: runError, ticketId, projectId }, "Could not confirm Jenkins verification was queued for remediation PR");
            await supabase.from("tickets").update({ ci_status: "needs_review", ci_error: "Bankai could not confirm a Jenkins run was queued. Retry verification from the ticket." })
              .eq("id", ticketId).eq("project_id", projectId).eq("github_fix_commit_sha", headSha);
          } else {
            const ciStatus = run.status === "queued" ? "queued" : run.status === "in_progress" ? "running"
              : run.status === "needs_review" ? "needs_review" : run.status === "cancelled" ? "cancelled"
                : run.conclusion === "passed" ? "passed" : run.conclusion === "failed" ? "failed"
                  : run.conclusion === "cancelled" ? "cancelled" : "needs_review";
            const ciError = ciStatus === "needs_review" ? "The existing Jenkins run needs review before this ticket can be verified." : null;
            await supabase.from("tickets").update({ ci_status: ciStatus, ci_error: ciError }).eq("id", ticketId).eq("project_id", projectId).eq("github_fix_commit_sha", headSha);
          }
        }
      } else if (verification?.verification_provider === "hosted_ci" && verification.ci_bootstrap_status === "ready") {
        await supabase.from("tickets").update({ ci_status: "queued", ci_error: null }).eq("id", ticketId).eq("project_id", projectId);
      } else {
        const ciError = verification?.verification_provider === "none"
          ? "No CI provider is configured for this project. Choose Jenkins or hosted CI in Settings."
          : "Hosted CI setup is pending review and merge of its workflow pull request.";
        await supabase.from("tickets").update({ ci_status: "pending_setup", ci_error: ciError }).eq("id", ticketId).eq("project_id", projectId);
      }
    }
    await maybeTransitionJira(jira, ticket.jira_issue_key, "In Review");

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
