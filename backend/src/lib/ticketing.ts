import type { SupabaseClient } from "@supabase/supabase-js";
import { recordActivity } from "./activity.js";
import { reconcileCollateralPackageMitigations } from "./collateral-remediation.js";
import { normalizeDate, normalizeSeverity, type FindingUpsertRow } from "./csv-ingest.js";
import { decrypt } from "./crypto.js";
import { buildBranchName, createBranch, GithubApiError, type GithubCredentials } from "./github.js";
import { HttpError } from "./http-error.js";
import {
  addBranchComment,
  addIssueToSprint,
  buildFindingDescription,
  createIssue,
  JiraApiError,
  searchIssuesInProject,
  transitionIssue,
  updateIssue,
  type JiraCredentials,
  type JiraIssueSummary,
} from "./jira.js";
import { logger } from "./logger.js";
import type { Bucket, Severity, TicketStatus } from "./pipeline-types.js";
import { enqueueFixPrResume, FIX_PR_QUEUE_NAME } from "./queue.js";
import { computeSlaDueDate, computeSlaStatus, ttrStatusLabel, type SlaPolicyDays } from "./sla.js";
import { supabaseAdmin } from "./supabase.js";
import { statusAllowedByCompletionGate } from "./ticket-status-sync.js";

async function reconcileCollateralSafely(supabase: SupabaseClient, projectId: string, sourceTicketId: string): Promise<void> {
  try {
    await reconcileCollateralPackageMitigations(supabase, {
      projectId,
      sourceTicketId,
      loadJira: async () => (await loadJiraCreds(supabase, projectId))?.creds ?? null,
    });
  } catch (err) {
    // Direct ticket completion is authoritative and must not fail because an
    // optional fan-out reconciliation could not run. Duplicate webhooks make
    // the operation naturally retryable.
    logger.error({ err, projectId, sourceTicketId }, "Could not reconcile collateral package mitigations");
  }
}

// The per-finding "create a ticket, best-effort sync it to Jira, best-effort
// create a remediation branch" core, shared by two callers with very
// different auth contexts:
//  - ticket.controller.ts's createTickets: an interactive HTTP request, run
//    as the requesting user via a user-scoped Supabase client, gated by
//    requireRole and the create_project_ticket RPC's own project_role()
//    check.
//  - the repo-scan worker (M3): a BullMQ job with no user session, run as
//    the service-role client, calling create_project_ticket_system instead
//    (see supabase/migrations/20260718110000_add_ai_repo_scan.sql for why
//    that's a separate RPC rather than reusing create_project_ticket).
// Which RPC to call is the caller's decision (via `rpcName`), not inferred
// here, so this module never has to guess which auth context it's in.

export interface TicketRow {
  id: string;
  key: string;
  title: string;
  service: string | null;
  severity: Severity;
  status: TicketStatus;
  due_date: string | null;
  finding_id: string;
  created_at: string;
  jira_issue_key: string | null;
  jira_issue_url: string | null;
  jira_sync_error: string | null;
  github_branch_name: string | null;
  github_branch_url: string | null;
  github_branch_error: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_pr_state: string | null;
  github_pr_error: string | null;
  github_pr_low_confidence?: boolean;
  ci_status: string | null;
  ci_run_url: string | null;
  ci_error: string | null;
  collateral_resolution_event_id?: string | null;
  source?: "csv" | "github_ai" | "jira_import";
  // Only present when selected via SELECT_TICKET's join — absent on rows
  // returned directly from the create_project_ticket* RPCs.
  findings?: { external_id: string | null } | { external_id: string | null }[] | null;
}

export function toPublicTicket(row: TicketRow) {
  const overdue = row.status !== "Done" && !!row.due_date && new Date(`${row.due_date}T00:00:00Z`) < new Date();
  const findingRel = Array.isArray(row.findings) ? row.findings[0] : row.findings;
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    service: row.service ?? "Unassigned",
    severity: row.severity,
    status: row.status,
    dueDate: row.due_date,
    overdue,
    findingId: row.finding_id,
    findingExternalId: findingRel?.external_id ?? null,
    jiraIssueKey: row.jira_issue_key ?? null,
    jiraIssueUrl: row.jira_issue_url ?? null,
    jiraSyncError: row.jira_sync_error ?? null,
    githubBranchName: row.github_branch_name ?? null,
    githubBranchUrl: row.github_branch_url ?? null,
    githubBranchError: row.github_branch_error ?? null,
    githubPrNumber: row.github_pr_number ?? null,
    githubPrUrl: row.github_pr_url ?? null,
    githubPrState: row.github_pr_state ?? null,
    githubPrError: row.github_pr_error ?? null,
    githubPrLowConfidence: row.github_pr_low_confidence ?? false,
    ciStatus: row.ci_status ?? null,
    ciRunUrl: row.ci_run_url ?? null,
    ciError: row.ci_error ?? null,
    collateralResolved: !!row.collateral_resolution_event_id,
    createdAt: row.created_at,
  };
}

export const SELECT_TICKET =
  "id, key, title, service, severity, status, due_date, finding_id, created_at, jira_issue_key, jira_issue_url, jira_sync_error, github_branch_name, github_branch_url, github_branch_error, github_pr_number, github_pr_url, github_pr_state, github_pr_error, github_pr_low_confidence, ci_status, ci_run_url, ci_error, collateral_resolution_event_id, findings ( external_id )";

// Repairs legacy or racing writes that marked a ticket Done before both
// completion signals existed. The database trigger provides the hard guard;
// this read-boundary repair also fixes rows created before that migration.
export async function repairPrematureDoneTickets(supabase: SupabaseClient, projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("tickets")
    .select("id, github_branch_name, github_pr_number, github_pr_state, ci_status, collateral_resolution_event_id")
    .eq("project_id", projectId)
    .eq("status", "Done");

  if (error) {
    logger.error({ err: error, projectId }, "Could not inspect Done tickets for completion drift");
    return 0;
  }

  const repairs = (data ?? []).flatMap((ticket) => {
    const status = statusAllowedByCompletionGate("Done", {
      githubBranchName: ticket.github_branch_name,
      githubPrNumber: ticket.github_pr_number,
      githubPrState: ticket.github_pr_state,
      ciStatus: ticket.ci_status,
      collateralResolutionEventId: ticket.collateral_resolution_event_id,
    });
    return status === "Done" ? [] : [{ id: ticket.id as string, status }];
  });

  let repaired = 0;
  for (const repair of repairs) {
    const { error: updateError, count } = await supabase
      .from("tickets")
      .update({ status: repair.status }, { count: "exact" })
      .eq("id", repair.id)
      .eq("project_id", projectId)
      .eq("status", "Done");
    if (updateError) {
      logger.error({ err: updateError, projectId, ticketId: repair.id }, "Could not repair a premature Done ticket");
    } else {
      repaired += count ?? 0;
    }
  }

  if (repaired > 0) logger.warn({ projectId, repaired }, "Repaired tickets that reached Done before merge and CI completion");
  return repaired;
}

export interface ProjectJiraRow {
  jira_site: string | null;
  jira_key: string | null;
  jira_email: string | null;
  jira_api_token_enc: string | null;
  jira_connected_at: string | null;
}

export async function loadJiraCreds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ creds: JiraCredentials; projectKey: string } | null> {
  const { data } = await supabase
    .from("projects")
    .select("jira_site, jira_key, jira_email, jira_api_token_enc, jira_connected_at")
    .eq("id", projectId)
    .single();

  const row = data as ProjectJiraRow | null;
  if (!row?.jira_connected_at || !row.jira_site || !row.jira_key || !row.jira_email || !row.jira_api_token_enc) {
    return null;
  }

  return {
    creds: { site: row.jira_site, email: row.jira_email, apiToken: decrypt(row.jira_api_token_enc) },
    projectKey: row.jira_key,
  };
}

// Best-effort membership set for the scan-ingestion Jira dedup check (see
// excludeAlreadyTicketedFindings in csv-ingest.ts): every fingerprint that
// already has a Jira issue tracking it in the connected Jira project,
// regardless of which Bankai project/account originally created that
// issue — same cross-account reach as reconcileJiraTickets below, since
// this is a direct Jira API query, not a Bankai DB query. Never throws —
// an unreachable, rate-limited, or deauthorized Jira must not fail or
// block the surrounding scan; any failure degrades to "treat nothing as
// already-ticketed."
export async function fetchAlreadyTicketedFingerprints(
  jira: { creds: JiraCredentials; projectKey: string } | null,
): Promise<Set<string>> {
  if (!jira) return new Set();
  try {
    const issues = await searchIssuesInProject(jira.creds, jira.projectKey);
    return new Set(issues.flatMap((issue) => (issue.fingerprint ? [issue.fingerprint] : [])));
  } catch (err) {
    logger.error(
      { err, projectKey: jira.projectKey },
      "Could not check Jira for already-ticketed fingerprints during scan ingestion — proceeding without filtering",
    );
    return new Set();
  }
}

export interface ProjectGithubRow {
  github_repo: string | null;
  github_token_enc: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
}

export async function loadGithubCreds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ creds: GithubCredentials; defaultBranch: string } | null> {
  const { data } = await supabase
    .from("projects")
    .select("github_repo, github_token_enc, github_default_branch, github_connected_at")
    .eq("id", projectId)
    .single();

  const row = data as ProjectGithubRow | null;
  if (!row?.github_connected_at || !row.github_repo || !row.github_token_enc || !row.github_default_branch) {
    return null;
  }

  return {
    creds: { repo: row.github_repo, token: decrypt(row.github_token_enc) },
    defaultBranch: row.github_default_branch,
  };
}

export interface TicketFormatContext {
  teamName: string | null;
  // The standardized ticket description's "Repository" line is just the
  // project's connected GitHub repo, not a separately entered value.
  repository: string | null;
}

interface ProjectTicketFormatRow {
  team_name: string | null;
  github_repo: string | null;
}

// Loaded once per request (not per finding) by every buildFindingDescription
// caller — team_name/github_repo don't vary per finding within a project.
export async function loadTicketFormatContext(supabase: SupabaseClient, projectId: string): Promise<TicketFormatContext> {
  const { data } = await supabase.from("projects").select("team_name, github_repo").eq("id", projectId).single();

  const row = data as ProjectTicketFormatRow | null;
  return { teamName: row?.team_name ?? null, repository: row?.github_repo ?? null };
}

// "Finding Count" on the standardized ticket format: how many currently-open
// findings (any bucket but Resolved) this project has for the same service
// as the finding the ticket is being built for — computed fresh on every
// call rather than stored, so it always reflects current state. Falls back
// to 1 (the finding itself) on a query error rather than 0, since the
// finding being ticketed is always at least one open finding.
export async function countOpenFindingsForService(
  supabase: SupabaseClient,
  projectId: string,
  service: string | null,
): Promise<number> {
  let query = supabase
    .from("findings")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .neq("bucket", "Resolved");
  query = service === null ? query.is("service", null) : query.eq("service", service);

  const { count, error } = await query;
  if (error) {
    logger.error({ err: error, projectId, service }, "Could not count open findings for the Finding Count ticket field");
    return 1;
  }
  return count ?? 1;
}

// The ticket description's "Recommendations" field is populated directly
// from a CSV import's `recommendations` column when present (container/
// package-style findings). AI/GitHub-sourced findings never have that
// column, but do have Gemini's own detailed remediationGuidance text (see
// gemini.ts) — falling back to that (then to the shorter fixAvailable flag)
// means AI-sourced findings still get a useful Recommendations block instead
// of a bare "—".
export function resolveRecommendations(
  recommendations: string | null,
  remediationGuidance: string | null,
  fixAvailable: string | null,
): string | null {
  return recommendations ?? remediationGuidance ?? fixAvailable;
}

// Best-effort, same contract as Jira issue creation: a remediation branch is
// a convenience, not something that should fail ticket creation/sync if
// GitHub is unreachable or misconfigured. Returns the columns to fold into
// the caller's own `tickets` update — never throws. On success, also posts a
// best-effort comment on the linked Jira issue so the branch is visible from
// Jira itself, not just Bankai.
export async function attemptBranchCreation(
  github: { creds: GithubCredentials; defaultBranch: string } | null,
  jiraCreds: JiraCredentials | null,
  issueKey: string | null,
  fingerprint: string,
  cwe: string | null,
  filePath: string | null,
  ticketId: string,
  projectId: string,
  ticketKey: string,
): Promise<
  | {
      github_branch_name: string;
      github_branch_url: string;
      github_branch_error: null;
      github_pr_error: null;
      status: "In Progress";
    }
  | { github_branch_name: null; github_branch_url: null; github_branch_error: string }
  | null
> {
  if (!github) return null;
  try {
    const name = buildBranchName(fingerprint, cwe, filePath, { projectId, ticketKey });
    const branch = await createBranch(github.creds, { baseBranch: github.defaultBranch, branchName: name });

    // Jira is optional: a GitHub-only project has no issue to comment on or
    // transition. Same best-effort pattern as the rest of this module.
    if (jiraCreds && issueKey) {
      const comment = await addBranchComment(jiraCreds, issueKey, branch);
      if (!comment.ok) {
        logger.error(
          { ticketId, issueKey, status: comment.status, message: comment.message },
          "Could not post the remediation branch link as a Jira comment",
        );
      }
      void transitionIssue(jiraCreds, issueKey, "In Progress");
    }

    return {
      github_branch_name: branch.name,
      github_branch_url: branch.url,
      github_branch_error: null,
      github_pr_error: null,
      status: "In Progress",
    };
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not create a remediation branch.";
    logger.error({ err, ticketId }, "GitHub branch creation failed");
    return { github_branch_name: null, github_branch_url: null, github_branch_error: message };
  }
}

// Best-effort enqueue of the fix-pr job whenever a ticket needs automated
// remediation. Uses a fresh BullMQ id each time so a stale completed/failed
// `fix-pr-${ticketId}` job cannot silently suppress a new assignment/retry.
export async function maybeEnqueueFixPrJob(
  ticketId: string,
  projectId: string,
  findingSource?: "csv" | "github_ai" | "jira_import" | null,
): Promise<boolean> {
  try {
    const job = await enqueueFixPrResume({ ticketId, projectId });
    const { error: statusError } = await supabaseAdmin
      .from("tickets")
      .update({ status: "In Progress", github_pr_error: null })
      .eq("id", ticketId)
      .eq("project_id", projectId);
    if (statusError) {
      logger.error({ err: statusError, ticketId, projectId }, "Could not mark an enqueued remediation ticket In Progress");
    }
    logger.info(
      { ticketId, projectId, findingSource: findingSource ?? null, queue: FIX_PR_QUEUE_NAME, jobId: job.id ?? null },
      "Enqueued fix-pr job",
    );
    return true;
  } catch (err) {
    logger.error({ err, ticketId, projectId, queue: FIX_PR_QUEUE_NAME }, "Could not enqueue the fix-pr job");
    const { error: persistError } = await supabaseAdmin
      .from("tickets")
      .update({
        github_pr_error: "Could not enqueue the automated remediation job. Check the Bankai worker and Redis.",
      })
      .eq("id", ticketId);
    if (persistError) {
      logger.error({ err: persistError, ticketId, projectId }, "Could not persist fix-pr enqueue failure on the ticket");
    }
    return false;
  }
}

export interface FindingForTicket {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  external_id: string | null;
  rationale: string | null;
  cvss_score: number | null;
  cwe: string | null;
  component: string | null;
  file_path: string | null;
  finding_type: string | null;
  source_status: string | null;
  date_found: string | null;
  description: string | null;
  fix_available: string | null;
  source_url: string | null;
  environment: string | null;
  cves: string | null;
  affected_packages: string | null;
  current_versions: string | null;
  fixed_versions: string | null;
  recommendations: string | null;
  remediation_guidance: string | null;
  commit_sha: string | null;
  line_start: number | null;
  line_end: number | null;
  source: "csv" | "github_ai" | "jira_import";
}

export interface TicketingActor {
  id: string | null;
  label: string;
}

export interface CreateTicketForFindingInput {
  projectId: string;
  finding: FindingForTicket;
  jira: { creds: JiraCredentials; projectKey: string; targetSprintId: number | null } | null;
  github: { creds: GithubCredentials; defaultBranch: string } | null;
  actor: TicketingActor;
  // create_project_ticket (RLS/project_role()-gated, for an interactive user
  // session) or create_project_ticket_system (service-role only, for the
  // repo-scan worker) — see the migration comment above.
  rpcName: "create_project_ticket" | "create_project_ticket_system";
  // Needed for the ticket description's Team/Image/Finding Count/TTR Status
  // fields — loaded once by the caller (loadTicketFormatContext), not
  // per-finding, since team_name/github_repo don't vary within a project.
  formatContext: TicketFormatContext;
  slaPolicyDays: SlaPolicyDays;
  activityMeta?: string;
}

// Claims a ticket key, creates the Bankai ticket, then best-effort syncs it
// to Jira and best-effort creates a remediation branch. Throws only for the
// ticket-claim step itself (a real failure to create); Jira/GitHub failures
// are captured on the ticket row instead, matching the rest of this
// codebase's "best-effort integrations" convention.
export async function createTicketForFinding(
  supabase: SupabaseClient,
  input: CreateTicketForFindingInput,
): Promise<{ ticket: ReturnType<typeof toPublicTicket>; remediationQueued: boolean }> {
  const { projectId, finding, jira, actor, rpcName, formatContext, slaPolicyDays } = input;

  const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
    p_project_id: projectId,
    p_finding_id: finding.id,
    p_title: finding.title,
    p_service: finding.service,
    p_severity: finding.severity,
    p_due_date: finding.sla_due_date,
  });

  if (rpcError || !ticket) {
    if (rpcError?.code === "42501") {
      throw new HttpError(403, "You do not have permission to create tickets in this project.");
    }
    if (rpcError?.code === "P0002") {
      throw new HttpError(404, "Project not found");
    }
    throw new HttpError(500, `Could not create a ticket for "${finding.title}".`);
  }

  let ticketRow = ticket as TicketRow;

  // Best-effort: a Jira outage or misconfiguration must not fail ticket
  // creation in Bankai — the internal ticket already exists either way.
  if (jira) {
    try {
      const summary = `[${finding.service ?? "Unassigned"}] ${finding.title}`;
      const findingCount = await countOpenFindingsForService(supabase, projectId, finding.service);
      const ttrStatus = ttrStatusLabel(computeSlaStatus(finding.severity, finding.sla_due_date, slaPolicyDays));
      const description = buildFindingDescription({
        id: finding.id,
        fingerprint: finding.fingerprint,
        externalId: finding.external_id,
        title: finding.title,
        severity: finding.severity,
        cvssScore: finding.cvss_score,
        cwe: finding.cwe,
        component: finding.component,
        filePath: finding.file_path,
        findingType: finding.finding_type,
        sourceStatus: finding.source_status,
        dateFound: finding.date_found,
        description: finding.description ?? finding.rationale,
        fixAvailable: finding.fix_available,
        sourceUrl: finding.source_url,
        commitSha: finding.commit_sha,
        lineStart: finding.line_start,
        lineEnd: finding.line_end,
        teamName: formatContext.teamName,
        service: finding.service,
        environment: finding.environment,
        findingCount,
        ttrStatus,
        cves: finding.cves,
        repository: formatContext.repository,
        affectedPackages: finding.affected_packages,
        currentVersions: finding.current_versions,
        fixedVersions: finding.fixed_versions,
        recommendations: resolveRecommendations(finding.recommendations, finding.remediation_guidance, finding.fix_available),
      });

      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: finding.severity,
        dueDate: finding.sla_due_date,
      });
      if (jira.targetSprintId) {
        const sprintResult = await addIssueToSprint(jira.creds, jira.targetSprintId, issue.key);
        if (!sprintResult.ok) {
          logger.error(
            { status: sprintResult.status, message: sprintResult.message, ticketId: ticketRow.id, issueKey: issue.key, sprintId: jira.targetSprintId },
            "Jira issue was created but could not be added to the target sprint",
          );
        }
      }

      const { data: updated } = await supabase
        .from("tickets")
        .update({
          jira_issue_key: issue.key,
          jira_issue_url: issue.url,
          jira_sync_error: null,
        })
        .eq("id", ticketRow.id)
        .select(SELECT_TICKET)
        .single();
      if (updated) ticketRow = updated as TicketRow;
    } catch (err) {
      const message = err instanceof JiraApiError ? err.message : "Could not create a Jira issue for this ticket.";
      logger.error({ err, ticketId: ticketRow.id }, "Jira issue creation failed");
      const { data: updated } = await supabase
        .from("tickets")
        .update({ jira_sync_error: message })
        .eq("id", ticketRow.id)
        .select(SELECT_TICKET)
        .single();
      if (updated) ticketRow = updated as TicketRow;
    }
  }

  // Always enqueue. The worker loads GitHub creds with
  // the service role, so a user-scoped loadGithubCreds miss here must not
  // silently skip Quincy/Gemini remediation.
  const enqueued = await maybeEnqueueFixPrJob(ticketRow.id, projectId, finding.source);
  const { data: updated } = await supabase.from("tickets").select(SELECT_TICKET).eq("id", ticketRow.id).single();
  if (updated) ticketRow = updated as TicketRow;

  const publicTicket = toPublicTicket(ticketRow);

  await recordActivity(supabase, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.label,
    eventType: "ticket",
    summary: "created",
    linkLabel: publicTicket.key,
    linkTo: "tickets",
    meta: input.activityMeta ?? `${finding.title} · from a marked-for-Jira finding`,
  });

  return { ticket: publicTicket, remediationQueued: enqueued };
}

// A rescan omission alone cannot close a ticket. Reconcile completion only
// after a fix PR has merged, including tickets that never received a PR.
export async function closeTicketsForResolvedFindings(
  supabase: SupabaseClient,
  input: { projectId: string; resolvedFindingIds: string[]; jira: JiraCredentials | null },
): Promise<void> {
  const { projectId, resolvedFindingIds, jira } = input;
  if (resolvedFindingIds.length === 0) return;

  const { data: candidates, error: selectError } = await supabase
    .from("tickets")
    .select("id, jira_issue_key, github_pr_state, ci_status")
    .eq("project_id", projectId)
    .in("finding_id", resolvedFindingIds)
    .neq("status", "Done");

  if (selectError) {
    logger.error({ err: selectError, projectId }, "Could not auto-close tickets for resolved findings");
    return;
  }

  // A missing scanner result is not proof of remediation. In particular,
  // tickets without a PR must remain actionable until a fix actually lands.
  const toClose = (candidates ?? []).filter((t) => t.github_pr_state === "merged" && t.ci_status === "passed");
  if (toClose.length === 0) return;

  const { data: closedRows, error } = await supabase
    .from("tickets")
    .update({ status: "Done" })
    .eq("github_pr_state", "merged")
    .eq("ci_status", "passed")
    .in(
      "id",
      toClose.map((t) => t.id),
    )
    .select("id, jira_issue_key");

  if (error) {
    logger.error({ err: error, projectId }, "Could not auto-close tickets for resolved findings");
    return;
  }

  if (jira) {
    const withJiraIssue = (closedRows ?? []).filter((t): t is { id: string; jira_issue_key: string } => !!t.jira_issue_key);
    await Promise.allSettled(withJiraIssue.map((t) => transitionIssue(jira, t.jira_issue_key, "Done")));
  }
}

// Called from webhook.controller.ts's pull_request handler when a PR is
// merged. Completion is reconciled here, but only a prior passing CI result
// can move the ticket (and Jira issue) to Done.
export async function markTicketPrMerged(
  supabase: SupabaseClient,
  input: { projectId: string; prNumber: number },
): Promise<void> {
  const { data: ticket, error } = await supabase
    .from("tickets")
    .update({ github_pr_state: "merged", github_pr_error: null })
    .eq("project_id", input.projectId)
    .eq("github_pr_number", input.prNumber)
    .select("id, key, title, jira_issue_key, ci_status")
    .maybeSingle();

  if (error) {
    logger.error({ err: error, ...input }, "Could not record the merged PR on its ticket");
    return;
  }
  if (!ticket) return;

  const nextStatus = ticket.ci_status === "passed" ? "Done" : "In Review";
  let completion = supabase.from("tickets").update({ status: nextStatus }).eq("id", ticket.id).neq("status", nextStatus);
  completion = nextStatus === "Done" ? completion.eq("ci_status", "passed") : completion.or("ci_status.is.null,ci_status.neq.passed");
  const { data: transitioned, error: transitionError } = await completion.select("id").maybeSingle();
  if (transitionError) {
    logger.error({ err: transitionError, ticketId: ticket.id }, "Could not reconcile completion after PR merge");
    return;
  }
  if (nextStatus === "Done") {
    await reconcileCollateralSafely(supabase, input.projectId, ticket.id);
  }
  if (!transitioned) return;

  if (ticket.jira_issue_key) {
    const jira = await loadJiraCreds(supabase, input.projectId);
    if (jira) await transitionIssue(jira.creds, ticket.jira_issue_key, nextStatus);
  }

  await recordActivity(supabase, {
    projectId: input.projectId,
    actorId: null,
    actorLabel: "GitHub",
    eventType: "ticket",
    summary: "pull request merged for",
    linkLabel: ticket.key,
    linkTo: "tickets",
    meta: `${ticket.title} · PR #${input.prNumber}`,
  });
}

// Reopens a Done ticket whose finding is still open (bucket != Resolved) so
// triage can drive remediation again — e.g. after a stale Done was inherited
// from a linked Jira issue that another project had already closed. Refuses
// when the finding is Resolved (that ticket's work is genuinely finished).
// Best-effort transitions the linked Jira issue back to "In Progress".
export async function reopenTicket(
  supabase: SupabaseClient,
  input: { projectId: string; ticketId: string; actor: TicketingActor },
): Promise<TicketRow> {
  const { projectId, ticketId, actor } = input;

  const { data: existing, error: loadError } = await supabase
    .from("tickets")
    .select("id, key, title, status, jira_issue_key, github_pr_number, findings ( bucket, source )")
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (loadError) {
    throw new HttpError(500, "Could not load this ticket to reopen.");
  }
  if (!existing) {
    throw new HttpError(404, "Ticket not found");
  }
  if (existing.status !== "Done") {
    throw new HttpError(422, "Only a Done ticket can be reopened.");
  }

  const findingRel = Array.isArray(existing.findings) ? existing.findings[0] : existing.findings;
  const bucket = (findingRel as { bucket: Bucket } | null | undefined)?.bucket ?? null;
  if (bucket === "Resolved" && existing.github_pr_number != null) {
    throw new HttpError(422, "Cannot reopen a ticket whose finding is Resolved.");
  }

  const { data: updated, error: updateError } = await supabase
    .from("tickets")
    .update({ status: "In Progress" })
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .select(SELECT_TICKET)
    .maybeSingle();

  if (updateError || !updated) {
    throw new HttpError(500, "Could not reopen this ticket.");
  }

  const ticketRow = updated as TicketRow;
  const reopenedFinding = Array.isArray(existing.findings) ? existing.findings[0] : existing.findings;
  const reopenedSource = (reopenedFinding as { source?: FindingForTicket["source"] } | null | undefined)?.source ?? null;
  if (existing.github_pr_number == null) {
    await maybeEnqueueFixPrJob(ticketId, projectId, reopenedSource);
  }

  if (ticketRow.jira_issue_key) {
    const jira = await loadJiraCreds(supabase, projectId);
    if (jira) void transitionIssue(jira.creds, ticketRow.jira_issue_key, "In Progress");
  }

  await recordActivity(supabase, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.label,
    eventType: "ticket",
    summary: "reopened",
    linkLabel: ticketRow.key,
    linkTo: "tickets",
    meta: `${ticketRow.title} · status Done → In Progress (finding still open)`,
  });

  return ticketRow;
}

// Called when a PR is closed WITHOUT being merged. Deliberately does not
// touch ticket.status (stays at "In Review") or auto-retry fix generation —
// "closed without merge" is ambiguous (wrong fix vs. superseded vs. no
// longer needed), and retrying automatically risks a second competing
// commit landing on the same branch. Surfacing github_pr_error is enough for
// a human to notice and decide what to do next; a manual retry action is a
// reasonable future addition, not built here.
export async function markTicketPrClosedWithoutMerge(
  supabase: SupabaseClient,
  input: { projectId: string; prNumber: number },
): Promise<void> {
  const { error } = await supabase
    .from("tickets")
    .update({ github_pr_state: "closed", github_pr_error: "Pull request was closed without being merged." })
    .eq("project_id", input.projectId)
    .eq("github_pr_number", input.prNumber);

  if (error) {
    logger.error({ err: error, ...input }, "Could not mark ticket's PR as closed-without-merge");
  }
}

// Called from webhook.controller.ts's workflow_run handler once a
// bankai-verify.yml run for this ticket completes. Purely additive to the
// existing ticket lifecycle — ci_status never changes ticket.status or
// blocks a human from merging on GitHub; it only gates Bankai's own UI.
export async function markTicketPipelineResult(
  supabase: SupabaseClient,
  input: { projectId: string; ticketId: string; status: "passed" | "failed"; runUrl: string | null; commitSha?: string | null },
): Promise<void> {
  const { data: ticket, error } = await supabase
    .from("tickets")
    .update({ ci_status: input.status, ci_run_url: input.runUrl, ci_error: null, security_verified_commit_sha: input.status === "passed" ? input.commitSha ?? null : null })
    .eq("id", input.ticketId)
    .eq("project_id", input.projectId)
    .select("id, key, title, github_pr_state, github_pr_number")
    .maybeSingle();

  if (error) {
    logger.error({ err: error, ...input }, "Could not record pipeline result on ticket");
    return;
  }
  if (!ticket) return;

  if (ticket.github_pr_state === "merged" && ticket.github_pr_number != null) {
    await markTicketPrMerged(supabase, { projectId: input.projectId, prNumber: ticket.github_pr_number });
  }

  await recordActivity(supabase, {
    projectId: input.projectId,
    actorId: null,
    actorLabel: "Bankai CI",
    eventType: "pipeline",
    summary: input.status === "passed" ? "verification pipeline passed for" : "verification pipeline failed for",
    linkLabel: ticket.key,
    linkTo: "tickets",
    meta: input.runUrl ? `${ticket.title} · ${input.runUrl}` : ticket.title,
  });
}

// Called from webhook.controller.ts when the one-time "bankai/ci-bootstrap"
// PR (adding bankai-verify.yml to the target repo's default branch) is
// merged. Flips the project to 'ready' and returns every ticket that was
// left at ci_status='pending_setup' waiting on this, so the caller can
// re-enqueue their pipeline verification now that dispatch will work.
export interface PendingBootstrapTicket {
  id: string;
  github_branch_name: string | null;
  github_pr_number: number | null;
}

export async function markBootstrapPrMerged(supabase: SupabaseClient, projectId: string): Promise<PendingBootstrapTicket[]> {
  const { error: projectError } = await supabase
    .from("projects")
    .update({ ci_bootstrap_status: "ready" })
    .eq("id", projectId);
  if (projectError) {
    logger.error({ err: projectError, projectId }, "Could not mark CI bootstrap PR as merged");
    return [];
  }

  const { data: pending, error: pendingError } = await supabase
    .from("tickets")
    .select("id, github_branch_name, github_pr_number")
    .eq("project_id", projectId)
    .eq("ci_status", "pending_setup");
  if (pendingError) {
    logger.error({ err: pendingError, projectId }, "Could not load tickets pending CI setup after bootstrap merge");
    return [];
  }

  return (pending ?? []) as PendingBootstrapTicket[];
}

export interface ReconcileJiraTicketsInput {
  projectId: string;
  jira: { creds: JiraCredentials; projectKey: string };
  actor: TicketingActor;
  // Same distinction as CreateTicketForFindingInput.rpcName — an
  // interactive request (connectJira, syncTickets) uses the RLS-gated RPC.
  rpcName: "create_project_ticket" | "create_project_ticket_system";
  // Needed to compute sla_due_date on any finding imported fresh from a
  // Jira issue (see the import pass below) — same policy planIngest uses.
  slaPolicyDays: SlaPolicyDays;
}

interface ReconcileCandidateFinding {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  bucket: Bucket;
  tickets: { id: string }[] | { id: string } | null;
}

// Finds Jira issues in the connected Jira project that carry the portable
// "Fingerprint:" marker buildFindingDescription embeds, and either:
//  - links one to a matching finding this project already has but hasn't
//    ticketed yet (Pass 1), or
//  - imports a brand-new finding + ticket from one that matches nothing
//    this project knows about at all (Pass 2) — e.g. an issue created by a
//    different Bankai account for the same github_repo pointed at the same
//    Jira project.
// Issues whose parsed "Repo:" marker disagrees with this project's
// github_repo are skipped entirely, so two Bankai projects sharing one
// Jira project (but wired to different GitHub repos) cannot cross-link or
// import each other's issues when fingerprints collide. Legacy issues with
// no "Repo:" line keep fingerprint-only matching (with a warning).
// Either way, RLS/ownership stay untouched: each project only ever writes
// its own findings/tickets, and tickets.finding_id stays NOT NULL/unique —
// Pass 2 always inserts the finding before claiming a ticket for it, same
// contract as every other ticket-creation path in this file.
//
// Resolved findings are excluded from Pass 1 (reconciling a finding that's
// already closed would immediately need to be re-closed) but still count
// toward "already known" for Pass 2, so a resolved finding's issue is never
// re-imported as a duplicate.
export async function reconcileJiraTickets(
  supabase: SupabaseClient,
  input: ReconcileJiraTicketsInput,
): Promise<{ reconciled: number; imported: number }> {
  const { projectId, jira, actor, rpcName, slaPolicyDays } = input;

  const [{ data: findings, error }, { data: projectRow }] = await Promise.all([
    supabase.from("findings").select("id, fingerprint, title, service, severity, sla_due_date, bucket, tickets ( id )").eq("project_id", projectId),
    supabase.from("projects").select("github_repo").eq("id", projectId).single(),
  ]);

  if (error) {
    logger.error({ err: error, projectId }, "Could not load findings for Jira reconciliation");
    return { reconciled: 0, imported: 0 };
  }

  const projectRepo = (projectRow as { github_repo: string | null } | null)?.github_repo ?? null;

  const allFindings = (findings ?? []) as ReconcileCandidateFinding[];
  const knownFingerprints = new Set(allFindings.map((f) => f.fingerprint));
  const candidates = allFindings.filter(
    (f) => f.bucket !== "Resolved" && (Array.isArray(f.tickets) ? f.tickets.length === 0 : !f.tickets),
  );

  const issues = await searchIssuesInProject(jira.creds, jira.projectKey);
  const issueByFingerprint = new Map<string, JiraIssueSummary>();
  // Issues come back ORDER BY created DESC — first-write-wins keeps the
  // newest matching issue if more than one somehow shares a fingerprint
  // (e.g. a manually duplicated issue).
  for (const issue of issues) {
    if (!issue.fingerprint) continue;

    // Repo-aware gate: a present-and-mismatched Repo always skips. A missing
    // Repo (legacy issues) falls through to fingerprint-only matching.
    if (issue.repo != null) {
      if (issue.repo !== projectRepo) continue;
    } else {
      logger.warn(
        { issueKey: issue.key, projectId, projectRepo, fingerprint: issue.fingerprint },
        "Jira issue has no Repo marker; matching by fingerprint only (legacy)",
      );
    }

    if (!issueByFingerprint.has(issue.fingerprint)) {
      issueByFingerprint.set(issue.fingerprint, issue);
    }
  }
  if (issueByFingerprint.size === 0) return { reconciled: 0, imported: 0 };

  let reconciled = 0;
  for (const finding of candidates) {
    const issue = issueByFingerprint.get(finding.fingerprint);
    if (!issue) continue;

    const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
      p_project_id: projectId,
      p_finding_id: finding.id,
      p_title: finding.title,
      p_service: finding.service,
      p_severity: finding.severity,
      p_due_date: finding.sla_due_date,
    });
    if (rpcError || !ticket) {
      logger.error({ err: rpcError, findingId: finding.id }, "Could not claim a ticket during Jira reconciliation");
      continue;
    }

    const ticketRow = ticket as TicketRow;
    const { error: linkError } = await supabase
      .from("tickets")
      .update({ jira_issue_key: issue.key, jira_issue_url: issue.url })
      .eq("id", ticketRow.id);
    if (linkError) {
      logger.error({ err: linkError, ticketId: ticketRow.id }, "Could not link reconciled ticket to its Jira issue");
      continue;
    }

    reconciled++;
    await recordActivity(supabase, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.label,
      eventType: "ticket",
      summary: "linked to existing Jira issue",
      linkLabel: ticketRow.key,
      linkTo: "tickets",
      meta: `${finding.title} · matched Jira issue ${issue.key} by fingerprint`,
    });
  }

  let imported = 0;
  const now = new Date();
  for (const [fingerprint, issue] of issueByFingerprint) {
    if (knownFingerprints.has(fingerprint)) continue;

    const severity = normalizeSeverity(issue.severity ?? undefined, issue.cvssScore ?? null);
    const dateFound = normalizeDate(issue.dateFound ?? undefined);
    const dueFrom = dateFound ? new Date(`${dateFound}T00:00:00Z`) : now;

    const row: FindingUpsertRow = {
      project_id: projectId,
      scan_id: null,
      fingerprint,
      external_id: null,
      title: issue.title || `Untitled finding imported from Jira issue ${issue.key}`,
      severity,
      cvss_score: issue.cvssScore ?? null,
      cwe: issue.cwe ?? null,
      component: issue.component ?? null,
      file_path: issue.filePath ?? null,
      finding_type: issue.findingType ?? null,
      source_status: issue.sourceStatus ?? null,
      date_found: dateFound,
      description: issue.description ?? null,
      fix_available: issue.fixAvailable ?? null,
      source_url: issue.sourceUrl ?? null,
      service: issue.service ?? null,
      environment: null,
      cves: null,
      affected_packages: null,
      current_versions: null,
      fixed_versions: null,
      recommendations: null,
      bucket: "New Delta",
      confidence: 80,
      rationale: `Imported from Jira issue ${issue.key} — created by a different Bankai project sharing this Jira connection.`,
      sla_due_date: computeSlaDueDate(severity, dueFrom, slaPolicyDays),
      last_seen_at: now.toISOString(),
      remediation_guidance: null,
      line_start: null,
      line_end: null,
      commit_sha: null,
      source: "jira_import",
    };

    // Upsert (not insert) purely as a concurrency backstop against a
    // same-project race with another reconcile run — not because duplicates
    // are expected in the common case.
    const { data: newFinding, error: insertError } = await supabase
      .from("findings")
      .upsert(row, { onConflict: "project_id,fingerprint" })
      .select("id, title, service, severity, sla_due_date")
      .single();
    if (insertError || !newFinding) {
      logger.error({ err: insertError, fingerprint }, "Could not import a finding from a Jira issue during reconciliation");
      continue;
    }

    const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
      p_project_id: projectId,
      p_finding_id: newFinding.id,
      p_title: newFinding.title,
      p_service: newFinding.service,
      p_severity: newFinding.severity,
      p_due_date: newFinding.sla_due_date,
    });
    if (rpcError || !ticket) {
      logger.error({ err: rpcError, findingId: newFinding.id }, "Could not claim a ticket for a Jira-imported finding");
      continue;
    }

    const ticketRow = ticket as TicketRow;
    const { error: linkError } = await supabase
      .from("tickets")
      .update({ jira_issue_key: issue.key, jira_issue_url: issue.url })
      .eq("id", ticketRow.id);
    if (linkError) {
      logger.error({ err: linkError, ticketId: ticketRow.id }, "Could not link an imported ticket to its Jira issue");
      continue;
    }

    imported++;
    await recordActivity(supabase, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.label,
      eventType: "ticket",
      summary: "imported from Jira",
      linkLabel: ticketRow.key,
      linkTo: "tickets",
      meta: `${newFinding.title} · imported from Jira issue ${issue.key} — no matching local finding existed`,
    });
  }

  return { reconciled, imported };
}

export interface UpdateTicketsForChangedFindingsInput {
  projectId: string;
  findingIds: string[];
  jira: JiraCredentials | null;
  slaPolicyDays: SlaPolicyDays;
}

interface FindingChangeSnapshot {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  external_id: string | null;
  rationale: string | null;
  cvss_score: number | null;
  cwe: string | null;
  component: string | null;
  file_path: string | null;
  finding_type: string | null;
  source_status: string | null;
  date_found: string | null;
  description: string | null;
  fix_available: string | null;
  source_url: string | null;
  environment: string | null;
  cves: string | null;
  affected_packages: string | null;
  current_versions: string | null;
  fixed_versions: string | null;
  recommendations: string | null;
  remediation_guidance: string | null;
  commit_sha: string | null;
  line_start: number | null;
  line_end: number | null;
}

interface ChangedTicketRow {
  id: string;
  title: string;
  service: string | null;
  severity: Severity;
  due_date: string | null;
  jira_issue_key: string | null;
  findings: FindingChangeSnapshot | FindingChangeSnapshot[] | null;
}

// Called right after a scan's findings upsert (both the CSV and GitHub-AI
// paths) — for every just-upserted finding that already has a linked
// ticket, compares the finding's current mirrored fields against the
// ticket's stored copies and propagates any drift, both to Bankai's own
// ticket row and (best-effort) to the linked Jira issue. Deliberately not
// gated by the "Changed" bucket — bucket classification (planIngest() in
// csv-ingest.ts) only flags severity/CVSS drift, but title/service/due-date
// drift is just as real and just as worth pushing. tickets.finding_id is
// UNIQUE, so this is a cheap 1:1 lookup, not a search.
export async function updateTicketsForChangedFindings(
  supabase: SupabaseClient,
  input: UpdateTicketsForChangedFindingsInput,
): Promise<{ updated: number }> {
  const { projectId, findingIds, jira, slaPolicyDays } = input;
  if (findingIds.length === 0) return { updated: 0 };

  const { data: rows, error } = await supabase
    .from("tickets")
    .select(
      "id, title, service, severity, due_date, jira_issue_key, finding_id, findings ( id, fingerprint, title, service, severity, sla_due_date, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url, environment, cves, affected_packages, current_versions, fixed_versions, recommendations, remediation_guidance, commit_sha, line_start, line_end )",
    )
    .eq("project_id", projectId)
    .in("finding_id", findingIds);

  if (error) {
    logger.error({ err: error, projectId }, "Could not load tickets to check for finding-change propagation");
    return { updated: 0 };
  }

  const formatContext = await loadTicketFormatContext(supabase, projectId);
  let updated = 0;
  for (const row of (rows ?? []) as ChangedTicketRow[]) {
    const finding = Array.isArray(row.findings) ? row.findings[0] : row.findings;
    if (!finding) continue;

    const changed =
      finding.title !== row.title ||
      finding.service !== row.service ||
      finding.severity !== row.severity ||
      finding.sla_due_date !== row.due_date;
    if (!changed) continue;

    const { error: updateError } = await supabase
      .from("tickets")
      .update({ title: finding.title, service: finding.service, severity: finding.severity, due_date: finding.sla_due_date })
      .eq("id", row.id);
    if (updateError) {
      logger.error({ err: updateError, ticketId: row.id }, "Could not propagate finding changes to ticket");
      continue;
    }
    updated++;

    if (jira && row.jira_issue_key) {
      const findingCount = await countOpenFindingsForService(supabase, projectId, finding.service);
      const ttrStatus = ttrStatusLabel(computeSlaStatus(finding.severity, finding.sla_due_date, slaPolicyDays));
      const description = buildFindingDescription({
        id: finding.id,
        fingerprint: finding.fingerprint,
        externalId: finding.external_id,
        title: finding.title,
        severity: finding.severity,
        cvssScore: finding.cvss_score,
        cwe: finding.cwe,
        component: finding.component,
        filePath: finding.file_path,
        findingType: finding.finding_type,
        sourceStatus: finding.source_status,
        dateFound: finding.date_found,
        description: finding.description ?? finding.rationale,
        fixAvailable: finding.fix_available,
        sourceUrl: finding.source_url,
        commitSha: finding.commit_sha,
        lineStart: finding.line_start,
        lineEnd: finding.line_end,
        teamName: formatContext.teamName,
        service: finding.service,
        environment: finding.environment,
        findingCount,
        ttrStatus,
        cves: finding.cves,
        repository: formatContext.repository,
        affectedPackages: finding.affected_packages,
        currentVersions: finding.current_versions,
        fixedVersions: finding.fixed_versions,
        recommendations: resolveRecommendations(finding.recommendations, finding.remediation_guidance, finding.fix_available),
      });
      const ok = await updateIssue(jira, row.jira_issue_key, {
        title: `[${finding.service ?? "Unassigned"}] ${finding.title}`,
        description,
        severity: finding.severity,
        dueDate: finding.sla_due_date,
      });
      await supabase
        .from("tickets")
        .update({ jira_sync_error: ok ? null : "Could not update the linked Jira issue with the latest finding details." })
        .eq("id", row.id);
    }
  }

  return { updated };
}
