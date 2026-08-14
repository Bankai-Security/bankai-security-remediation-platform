import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { recordOrgActivity } from "../lib/org-activity.js";
import type { ProjectRole } from "../lib/roles.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateTeamInput, UpdateTeamInput } from "../schemas/team.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface TeamRow {
  id: string;
  name: string;
  created_at: string;
}

// GET /orgs/:orgId/teams — teams in the org, RLS-scoped to what the caller can
// see (org members see all; a team-only member sees just their teams). myRole
// per team from team_role, exactly as listOrgs does with org_role.
export async function listTeams(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("teams")
    .select("id, name, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new HttpError(500, "Could not load teams.");
  }

  const teams = await Promise.all(
    ((data ?? []) as TeamRow[]).map(async (row) => {
      const { data: myRole } = await supabase.rpc("team_role", { p_team_id: row.id });
      return {
        id: row.id,
        name: row.name,
        myRole: (myRole as ProjectRole | null) ?? "viewer",
        createdAt: row.created_at,
      };
    }),
  );

  res.status(200).json({ teams });
}

export async function createTeam(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const { name } = req.body as CreateTeamInput;
  const supabase = userScopedClient(req);

  // Unlike createOrg/createProject, the teams SELECT policy checks
  // org_role(org_id) on the *parent* org (which already exists) — not the
  // not-yet-committed team row — so INSERT ... RETURNING re-checks cleanly and
  // we can select the row back inline.
  const { data, error } = await supabase
    .from("teams")
    .insert({ org_id: org.id, name })
    .select("id, name, created_at")
    .single();

  if (error) {
    logger.error({ err: error, orgId: org.id }, "Could not create team");
    throw new HttpError(500, "Could not create team.");
  }

  await recordOrgActivity(supabase, {
    orgId: org.id,
    teamId: data.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "team",
    summary: `created team "${data.name}"`,
  });

  res.status(201).json({ team: { id: data.id, name: data.name, myRole: "admin" as const, createdAt: data.created_at } });
}

export async function updateTeam(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const { name } = req.body as UpdateTeamInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("teams")
    .update({ name })
    .eq("id", team.id)
    .select("id, name")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this team.");
  }
  if (!data) {
    throw new HttpError(404, "Team not found");
  }

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "team",
    summary: `renamed team "${team.name}" to "${data.name}"`,
  });

  res.status(200).json({ team: { id: data.id, name: data.name } });
}

// Deleting a team is an org-level decision (RLS: org owners/admins), so this
// gates on the org role, not the team role. The team's project_teams links are
// `on delete cascade`, so its projects simply lose this team (they keep any
// other team memberships).
export async function deleteTeam(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  const team = req.team!;
  requireRole(org.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { error, count } = await supabase.from("teams").delete({ count: "exact" }).eq("id", team.id);

  if (error) {
    throw new HttpError(500, "Could not delete this team.");
  }
  if (!count) {
    throw new HttpError(404, "Team not found");
  }

  // teamId deliberately omitted: the team row is gone, so the FK couldn't
  // reference it — the name in the summary is the surviving record.
  await recordOrgActivity(supabase, {
    orgId: org.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "team",
    summary: `deleted team "${team.name}"`,
  });

  res.status(204).send();
}
