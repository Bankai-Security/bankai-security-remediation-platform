import type { SupabaseClient } from "@supabase/supabase-js";
import { recordActivity } from "./activity.js";
import { decrypt } from "./crypto.js";
import { buildBranchName, createBranch, GithubApiError, type GithubCredentials } from "./github.js";
import { HttpError } from "./http-error.js";
import {
  addBranchComment,
  addIssueToSprint,
  buildFindingDescription,
  createIssue,
  JiraApiError,
  transitionIssue,
  type JiraCredentials,
} from "./jira.js";
import { logger } from "./logger.js";
import type { Severity, TicketStatus } from "./pipeline-types.js";

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
    createdAt: row.created_at,
  };
}

export const SELECT_TICKET =
  "id, key, title, service, severity, status, due_date, finding_id, created_at, jira_issue_key, jira_issue_url, jira_sync_error, github_branch_name, github_branch_url, github_branch_error, findings ( external_id )";

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

// Best-effort, same contract as Jira issue creation: a remediation branch is
// a convenience, not something that should fail ticket creation/sync if
// GitHub is unreachable or misconfigured. Returns the columns to fold into
// the caller's own `tickets` update — never throws. On success, also posts a
// best-effort comment on the linked Jira issue so the branch is visible from
// Jira itself, not just Bankai.
export async function attemptBranchCreation(
  github: { creds: GithubCredentials; defaultBranch: string } | null,
  jiraCreds: JiraCredentials,
  issueKey: string,
  ticketKey: string,
  title: string,
  ticketId: string,
): Promise<{ github_branch_name: string | null; github_branch_url: string | null; github_branch_error: string | null } | null> {
  if (!github) return null;
  try {
    const name = buildBranchName(ticketKey, title);
    const branch = await createBranch(github.creds, { baseBranch: github.defaultBranch, branchName: name });

    const comment = await addBranchComment(jiraCreds, issueKey, branch);
    if (!comment.ok) {
      logger.error(
        { ticketId, issueKey, status: comment.status, message: comment.message },
        "Could not post the remediation branch link as a Jira comment",
      );
    }

    return { github_branch_name: branch.name, github_branch_url: branch.url, github_branch_error: null };
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not create a remediation branch.";
    logger.error({ err, ticketId }, "GitHub branch creation failed");
    return { github_branch_name: null, github_branch_url: null, github_branch_error: message };
  }
}

export interface FindingForTicket {
  id: string;
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
}

export interface TicketingActor {
  id: string | null;
  label: string;
}

export interface CreateTicketForFindingInput {
  projectId: string;
  finding: FindingForTicket;
  jira: { creds: JiraCredentials; projectKey: string; activeSprintId: number | null } | null;
  github: { creds: GithubCredentials; defaultBranch: string } | null;
  actor: TicketingActor;
  // create_project_ticket (RLS/project_role()-gated, for an interactive user
  // session) or create_project_ticket_system (service-role only, for the
  // repo-scan worker) — see the migration comment above.
  rpcName: "create_project_ticket" | "create_project_ticket_system";
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
): Promise<{ ticket: ReturnType<typeof toPublicTicket> }> {
  const { projectId, finding, jira, github, actor, rpcName } = input;

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
      const description = buildFindingDescription({
        id: finding.id,
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
      });

      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: finding.severity,
        dueDate: finding.sla_due_date,
      });
      if (jira.activeSprintId) {
        void addIssueToSprint(jira.creds, jira.activeSprintId, issue.key);
      }

      const branchColumns = await attemptBranchCreation(github, jira.creds, issue.key, ticketRow.key, finding.title, ticketRow.id);

      const { data: updated } = await supabase
        .from("tickets")
        .update({
          jira_issue_key: issue.key,
          jira_issue_url: issue.url,
          jira_sync_error: null,
          ...(branchColumns ?? {}),
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

  return { ticket: publicTicket };
}

// Called wherever findings get marked Resolved (a rescan no longer detects
// them) — a resolved finding means there's no more remediation work to do,
// so any ticket still open for it should close too, in both Bankai and
// (best-effort, same contract as every other Jira call in this file) Jira.
export async function closeTicketsForResolvedFindings(
  supabase: SupabaseClient,
  input: { projectId: string; resolvedFindingIds: string[]; jira: JiraCredentials | null },
): Promise<void> {
  const { projectId, resolvedFindingIds, jira } = input;
  if (resolvedFindingIds.length === 0) return;

  const { data: closedRows, error } = await supabase
    .from("tickets")
    .update({ status: "Done" })
    .eq("project_id", projectId)
    .in("finding_id", resolvedFindingIds)
    .neq("status", "Done")
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
