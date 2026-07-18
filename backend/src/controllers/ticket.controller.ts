import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { decrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/http-error.js";
import { addIssueToSprint, createIssue, getActiveSprintId, getIssueSnapshot, JiraApiError, transitionIssue, type JiraCredentials } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { Severity, TicketStatus } from "../lib/pipeline-types.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { CreateTicketsInput, UpdateTicketInput } from "../schemas/ticket.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface TicketRow {
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
  // Only present when selected via SELECT_TICKET's join — absent on rows
  // returned directly from the create_project_ticket RPC.
  findings?: { external_id: string | null } | { external_id: string | null }[] | null;
}

function toPublicTicket(row: TicketRow) {
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
    createdAt: row.created_at,
  };
}

const SELECT_TICKET =
  "id, key, title, service, severity, status, due_date, finding_id, created_at, jira_issue_key, jira_issue_url, jira_sync_error, findings ( external_id )";

interface ProjectJiraRow {
  jira_site: string | null;
  jira_key: string | null;
  jira_email: string | null;
  jira_api_token_enc: string | null;
  jira_connected_at: string | null;
}

async function loadJiraCreds(
  supabase: ReturnType<typeof createUserScopedSupabaseClient>,
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

export async function listTickets(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  let query = supabase.from("tickets").select(SELECT_TICKET).eq("project_id", req.project!.id);

  const { service, severity, status } = req.query;
  if (typeof service === "string" && service !== "all") query = query.eq("service", service);
  if (typeof severity === "string" && severity !== "all") query = query.eq("severity", severity);
  if (typeof status === "string" && status !== "all") query = query.eq("status", status);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    throw new HttpError(500, "Could not load tickets.");
  }

  res.status(200).json({ tickets: (data as TicketRow[]).map(toPublicTicket) });
}

export async function createTickets(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const { findingIds } = req.body as CreateTicketsInput;
  const supabase = userScopedClient(req);

  const { data: findings, error: findingsError } = await supabase
    .from("findings")
    .select("id, title, service, severity, sla_due_date, external_id, rationale, tickets ( id )")
    .eq("project_id", project.id)
    .in("id", findingIds);

  if (findingsError) {
    throw new HttpError(500, "Could not load the selected findings.");
  }

  const jira = await loadJiraCreds(supabase, project.id);
  const activeSprintId = jira ? await getActiveSprintId(jira.creds, jira.projectKey) : null;

  const created: ReturnType<typeof toPublicTicket>[] = [];
  const skipped: string[] = [];
  const actorLabel = displayNameFromUser(req.user!);

  for (const finding of findings ?? []) {
    const alreadyTicketed = Array.isArray(finding.tickets) ? finding.tickets.length > 0 : !!finding.tickets;
    if (alreadyTicketed) {
      skipped.push(finding.id);
      continue;
    }

    const { data: ticket, error: rpcError } = await supabase.rpc("create_project_ticket", {
      p_project_id: project.id,
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
        const description = [
          finding.rationale ?? "",
          finding.external_id ? `CVIT: ${finding.external_id}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const issue = await createIssue(jira.creds, {
          projectKey: jira.projectKey,
          title: summary,
          description,
          severity: finding.severity as Severity,
          dueDate: finding.sla_due_date,
        });
        if (activeSprintId) {
          void addIssueToSprint(jira.creds, activeSprintId, issue.key);
        }

        const { data: updated } = await supabase
          .from("tickets")
          .update({ jira_issue_key: issue.key, jira_issue_url: issue.url, jira_sync_error: null })
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
    created.push(publicTicket);

    await recordActivity(supabase, {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel,
      eventType: "ticket",
      summary: "created",
      linkLabel: publicTicket.key,
      linkTo: "tickets",
      meta: `${finding.title} · from a marked-for-Jira finding`,
    });
  }

  res.status(201).json({ tickets: created, skipped });
}

// Three-way, but all of it only runs when this is called (there's no
// webhook — that would need a publicly reachable HTTPS endpoint, which a
// local dev backend doesn't have):
//  - a ticket never linked to Jira (created before Jira was connected, or
//    whose automatic sync at creation time failed) gets a fresh issue created;
//  - a ticket whose linked issue still exists gets its current Jira status
//    pulled back into Bankai;
//  - a ticket whose linked issue was deleted directly in Jira is removed
//    from Bankai entirely (not recreated) — this frees its finding to be
//    re-added from AI Triage as a brand-new ticket/issue, rather than
//    silently resurrecting one the user deliberately deleted.
// Best-effort per ticket, same as createTickets.
export async function syncTickets(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const supabase = userScopedClient(req);

  const jira = await loadJiraCreds(supabase, project.id);
  if (!jira) {
    throw new HttpError(422, "Connect Jira in Settings before syncing tickets.");
  }
  const activeSprintId = await getActiveSprintId(jira.creds, jira.projectKey);

  const { data: rows, error } = await supabase
    .from("tickets")
    .select("id, key, title, service, severity, status, due_date, jira_issue_key, findings ( external_id, rationale )")
    .eq("project_id", project.id);

  if (error) {
    throw new HttpError(500, "Could not load tickets to sync.");
  }

  let synced = 0;
  let failed = 0;
  let statusPulled = 0;
  let removed = 0;
  const actorLabel = displayNameFromUser(req.user!);

  for (const row of rows ?? []) {
    if (row.jira_issue_key) {
      const snapshot = await getIssueSnapshot(jira.creds, row.jira_issue_key);
      if (snapshot.exists) {
        if (snapshot.status && snapshot.status !== row.status) {
          await supabase.from("tickets").update({ status: snapshot.status }).eq("id", row.id);
          statusPulled++;
        }
        continue;
      }

      const { error: deleteError, count } = await supabase
        .from("tickets")
        .delete({ count: "exact" })
        .eq("id", row.id);
      if (deleteError || !count) {
        logger.error({ err: deleteError, ticketId: row.id }, "Could not remove ticket for a deleted Jira issue");
        failed++;
        continue;
      }

      removed++;
      await recordActivity(supabase, {
        projectId: project.id,
        actorId: req.user!.id,
        actorLabel,
        eventType: "ticket",
        summary: "removed",
        linkLabel: row.key,
        linkTo: "tickets",
        meta: `${row.title} · linked Jira issue ${row.jira_issue_key} was deleted`,
      });
      continue;
    }

    const findingRel = Array.isArray(row.findings) ? row.findings[0] : row.findings;
    const summary = `[${row.service ?? "Unassigned"}] ${row.title}`;
    const description = [findingRel?.rationale ?? "", findingRel?.external_id ? `CVIT: ${findingRel.external_id}` : ""]
      .filter(Boolean)
      .join("\n");

    try {
      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: row.severity as Severity,
        dueDate: row.due_date,
      });
      if (activeSprintId) {
        void addIssueToSprint(jira.creds, activeSprintId, issue.key);
      }
      await supabase
        .from("tickets")
        .update({ jira_issue_key: issue.key, jira_issue_url: issue.url, jira_sync_error: null })
        .eq("id", row.id);
      synced++;
    } catch (err) {
      const message = err instanceof JiraApiError ? err.message : "Could not create a Jira issue for this ticket.";
      logger.error({ err, ticketId: row.id }, "Jira sync failed");
      await supabase.from("tickets").update({ jira_sync_error: message }).eq("id", row.id);
      failed++;
    }
  }

  if (synced > 0 || statusPulled > 0) {
    await recordActivity(supabase, {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel,
      eventType: "ticket",
      summary: "synced with Jira",
      meta: `${synced} ticket(s) created, ${statusPulled} status update(s) pulled${failed > 0 ? `, ${failed} failed` : ""}`,
    });
  }

  res.status(200).json({ synced, failed, statusPulled, removed });
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { status } = req.body as UpdateTicketInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("tickets")
    .update({ status })
    .eq("id", req.params.ticketId)
    .eq("project_id", req.project!.id)
    .select(SELECT_TICKET)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this ticket.");
  }
  if (!data) {
    throw new HttpError(404, "Ticket not found");
  }

  const ticketRow = data as TicketRow;

  // Best-effort — a missing/mismatched Jira transition must not fail the
  // status update in Bankai.
  if (ticketRow.jira_issue_key) {
    const jira = await loadJiraCreds(supabase, req.project!.id);
    if (jira) {
      void transitionIssue(jira.creds, ticketRow.jira_issue_key, status);
    }
  }

  res.status(200).json({ ticket: toPublicTicket(ticketRow) });
}
