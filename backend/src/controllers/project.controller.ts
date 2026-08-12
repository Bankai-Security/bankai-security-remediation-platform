import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { decrypt } from "../lib/crypto.js";
import { deleteBranch, deleteWebhook, type GithubCredentials } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { deleteIssue, type JiraCredentials } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { computeProjectStats } from "../lib/project-stats.js";
import type { ProjectRole } from "../lib/roles.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateProjectInput, DeleteProjectInput, UpdateProjectSettingsInput } from "../schemas/project.schema.js";

// The `teams ( ... )` embed follows projects.team_id → teams, and its nested
// organizations embed gives us the project's org id — so a single project fetch
// carries enough to render the team picker (which org's teams to offer) without
// a second round trip.
const PROJECT_COLUMNS =
  "id, name, description, team_name, team_id, jira_site, jira_key, jira_connected_at, sla_critical_days, sla_high_days, sla_medium_days, sla_low_days, status, created_at, teams ( id, name, org_id )";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  team_name: string | null;
  team_id: string | null;
  teams: { id: string; name: string; org_id: string } | { id: string; name: string; org_id: string }[] | null;
  jira_site: string | null;
  jira_key: string | null;
  jira_connected_at: string | null;
  sla_critical_days: number;
  sla_high_days: number;
  sla_medium_days: number;
  sla_low_days: number;
  status: "not_connected" | "active";
  created_at: string;
  project_services: { name: string }[];
}

async function toPublicProject(supabase: SupabaseClient, row: ProjectRow) {
  const policyDays = {
    Critical: row.sla_critical_days,
    High: row.sla_high_days,
    Medium: row.sla_medium_days,
    Low: row.sla_low_days,
  };
  const [stats, { data: myRole }] = await Promise.all([
    computeProjectStats(supabase, row.id, policyDays),
    supabase.rpc("project_role", { p_project_id: row.id }),
  ]);
  const team = Array.isArray(row.teams) ? row.teams[0] : row.teams;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teamName: row.team_name,
    // Hierarchy placement: the team the project sits in and (transitively) its
    // org. teamId is null for a project not yet assigned to any team.
    teamId: row.team_id,
    teamHierarchyName: team?.name ?? null,
    orgId: team?.org_id ?? null,
    status: row.status,
    services: row.project_services.map((s) => s.name),
    jiraSite: row.jira_site,
    jiraKey: row.jira_key,
    jiraConnected: row.jira_connected_at !== null,
    slaPolicyDays: { critical: policyDays.Critical, high: policyDays.High, medium: policyDays.Medium, low: policyDays.Low },
    myRole: (myRole as ProjectRole | null) ?? "viewer",
    stats: { totalCvits: stats.totalCvits, slaBreachedPct: stats.slaBreachedPct, openTickets: stats.openTickets },
    lastIntakeAt: stats.lastIntakeAt,
    createdAt: row.created_at,
  };
}

function userScopedClient(req: Request) {
  // requireAuth guarantees req.accessToken is set before any handler here runs.
  return createUserScopedSupabaseClient(req.accessToken as string);
}

// Ticket keys look like "<prefix>-101" (e.g. an "Acquisitions Audit" project
// gets "AA"). Multi-word names use initials; single-word names use the first
// three letters. Falls back to "PRJ" for names with no letters at all.
function deriveKeyPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words
          .slice(0, 4)
          .map((w) => w[0])
          .join("")
      : (words[0] ?? "").slice(0, 3);

  const prefix = letters.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return prefix || "PRJ";
}

export async function listProjects(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select(`${PROJECT_COLUMNS}, project_services ( name )`)
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load projects.");
  }

  const projects = await Promise.all((data as ProjectRow[]).map((row) => toPublicProject(supabase, row)));
  res.status(200).json({ projects });
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select(`${PROJECT_COLUMNS}, project_services ( name )`)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load project.");
  }
  if (!data) {
    throw new HttpError(404, "Project not found");
  }

  res.status(200).json({ project: await toPublicProject(supabase, data as ProjectRow) });
}

// PATCH /projects/:projectId — assign the project to a team in the hierarchy
// (or null to unassign). Replaces the old free-text team_name control. Mounted
// on the already-loadProject-scoped router, so req.project.myRole is available.
// Postgres enforces the FK: a teamId the caller can't actually reach (a team in
// an org they don't belong to) is a foreign-key violation surfaced as a 422,
// not a silent cross-org write.
export async function updateProjectSettings(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  const { teamId } = req.body as UpdateProjectSettingsInput;
  const supabase = userScopedClient(req);

  // The FK guarantees the team exists, but not that the caller may use it. A
  // team the caller can't see (one in an org they don't belong to) must not be
  // attachable — otherwise a project would surface in a stranger's org rollup.
  // The teams SELECT RLS returns only visible teams, so this is the auth gate.
  if (teamId !== null) {
    const { data: team } = await supabase.from("teams").select("id").eq("id", teamId).maybeSingle();
    if (!team) {
      throw new HttpError(422, "That team doesn't exist or you don't have access to it.");
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .update({ team_id: teamId })
    .eq("id", req.project!.id)
    .select("team_id")
    .single();

  if (error || !data) {
    if (error?.code === "23503") {
      throw new HttpError(422, "That team no longer exists.");
    }
    throw new HttpError(500, "Could not update the project's team.");
  }

  res.status(200).json({ teamId: data.team_id });
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const { name, description, teamId, teamName, services } = req.body as CreateProjectInput;
  const supabase = userScopedClient(req);

  // Same visibility gate as updateProjectSettings: the projects INSERT policy
  // only checks ownership, so without this a caller could attach a new project
  // to any team id, including one in an org they can't see. RLS on teams scopes
  // this lookup to teams the caller can actually reach.
  if (teamId) {
    const { data: team } = await supabase.from("teams").select("id").eq("id", teamId).maybeSingle();
    if (!team) {
      throw new HttpError(422, "That team doesn't exist or you don't have access to it.");
    }
  }

  // Insert without chaining .select(): PostgREST would turn that into
  // INSERT ... RETURNING, which re-checks the projects SELECT policy
  // (project_role(id) is not null) against the row from *this same*
  // statement — and project_role()'s own lookup into projects can't see
  // that not-yet-committed row, so the RETURNING check spuriously fails
  // with a row-level security violation even though the INSERT's own WITH
  // CHECK passed. Generating the id here lets us fetch the row back in a
  // separate request afterward, once it's committed and visible normally.
  const projectId = randomUUID();
  const { error: insertError } = await supabase.from("projects").insert({
    id: projectId,
    owner_id: req.user!.id,
    name,
    description: description || null,
    team_id: teamId ?? null,
    team_name: teamName || null,
    key_prefix: deriveKeyPrefix(name),
  });

  if (insertError) {
    logger.error({ err: insertError, userId: req.user!.id }, "Could not create project");
    throw new HttpError(500, "Could not create project.");
  }

  if (services.length > 0) {
    const { error: servicesError } = await supabase
      .from("project_services")
      .insert(services.map((serviceName) => ({ project_id: projectId, name: serviceName })));

    if (servicesError) {
      throw new HttpError(500, "Project created, but services could not be saved.");
    }
  }

  const { data: project, error: fetchError } = await supabase
    .from("projects")
    .select(`${PROJECT_COLUMNS}, project_services ( name )`)
    .eq("id", projectId)
    .single();

  if (fetchError || !project) {
    throw new HttpError(500, "Project created, but could not be loaded.");
  }

  res.status(201).json({ project: await toPublicProject(supabase, project as ProjectRow) });
}

// Owner-only, and requires typing the exact project name back — this is
// irreversible and cascades to every scan/finding/ticket/activity
// event/member/invite for the project (all FKs are `on delete cascade`).
// The projects table's DELETE RLS policy is already owner-only and
// unchanged since the very first migration, but the explicit checks below
// give a clear 403/422 instead of a bare 404 from a silently blocked RLS
// delete — the same belt-and-suspenders reasoning as every other gated
// mutation added this session.
export async function deleteProject(req: Request, res: Response): Promise<void> {
  const { confirmName } = req.body as DeleteProjectInput;
  const supabase = userScopedClient(req);

  const { data: project, error: fetchError } = await supabase
    .from("projects")
    .select(
      "id, name, owner_id, jira_site, jira_email, jira_api_token_enc, jira_connected_at, github_repo, github_token_enc, github_connected_at, github_webhook_id",
    )
    .eq("id", req.params.id)
    .maybeSingle();

  if (fetchError) {
    throw new HttpError(500, "Could not load this project.");
  }
  if (!project) {
    throw new HttpError(404, "Project not found");
  }
  if (project.owner_id !== req.user!.id) {
    throw new HttpError(403, "Only the project owner can delete this project.");
  }
  if (confirmName !== project.name) {
    throw new HttpError(422, "Type the exact project name to confirm deletion.");
  }

  // Gathered before the delete below (which cascades and removes these rows)
  // so the linked Jira issues and GitHub remediation branches can still be
  // cleaned up afterward.
  const jiraCreds: JiraCredentials | null =
    project.jira_connected_at && project.jira_site && project.jira_email && project.jira_api_token_enc
      ? { site: project.jira_site, email: project.jira_email, apiToken: decrypt(project.jira_api_token_enc) }
      : null;
  const githubCreds: GithubCredentials | null =
    project.github_connected_at && project.github_repo && project.github_token_enc
      ? { repo: project.github_repo, token: decrypt(project.github_token_enc) }
      : null;

  let jiraIssueKeys: string[] = [];
  let githubBranchNames: string[] = [];
  if (jiraCreds || githubCreds) {
    const { data: ticketRows } = await supabase
      .from("tickets")
      .select("jira_issue_key, github_branch_name")
      .eq("project_id", project.id);
    for (const t of ticketRows ?? []) {
      if (jiraCreds && t.jira_issue_key) jiraIssueKeys.push(t.jira_issue_key);
      if (githubCreds && t.github_branch_name) githubBranchNames.push(t.github_branch_name);
    }
  }

  const { error, count } = await supabase.from("projects").delete({ count: "exact" }).eq("id", project.id);

  if (error) {
    throw new HttpError(500, "Could not delete this project.");
  }
  if (!count) {
    throw new HttpError(404, "Project not found");
  }

  // Best-effort: the project is already gone from Bankai either way — a
  // Jira outage or a since-deleted issue must not turn a successful project
  // deletion into an error response.
  if (jiraCreds && jiraIssueKeys.length > 0) {
    const results = await Promise.allSettled(jiraIssueKeys.map((key) => deleteIssue(jiraCreds, key)));
    const failed = results.filter((r) => r.status === "rejected" || !r.value).length;
    if (failed > 0) {
      logger.error({ projectId: project.id, failed, total: jiraIssueKeys.length }, "Could not delete some Jira issues for a deleted project");
    }
  }

  // Same best-effort contract as the Jira cleanup above.
  if (githubCreds && githubBranchNames.length > 0) {
    const results = await Promise.allSettled(githubBranchNames.map((name) => deleteBranch(githubCreds, name)));
    const failed = results.filter((r) => r.status === "rejected" || !r.value).length;
    if (failed > 0) {
      logger.error({ projectId: project.id, failed, total: githubBranchNames.length }, "Could not delete some GitHub branches for a deleted project");
    }
  }
  if (githubCreds && project.github_webhook_id) {
    try {
      await deleteWebhook(githubCreds, project.github_webhook_id);
    } catch (err) {
      logger.warn({ err, projectId: project.id }, "Could not remove the GitHub webhook for a deleted project");
    }
  }

  res.status(204).send();
}
