import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { recordOrgActivity, toPublicOrgActivityEvent, type OrgActivityEventRow } from "../lib/org-activity.js";
import type { ProjectRole } from "../lib/roles.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateOrgInput, UpdateOrgInput } from "../schemas/org.schema.js";

function userScopedClient(req: Request) {
  // requireAuth guarantees req.accessToken is set before any handler here runs.
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface OrgRow {
  id: string;
  name: string;
  created_at: string;
}

type RollupProject = { id: string; name: string; status: string };

interface TeamRollupRow {
  id: string;
  name: string;
  created_at: string;
  // Projects reach teams through the project_teams join table now, so the embed
  // is one level deeper; a project in several teams appears under each.
  project_teams: { projects: RollupProject | RollupProject[] | null }[] | null;
}

// GET /orgs — every org the caller belongs to. RLS on organizations already
// scopes this to orgs where org_role() is non-null (owner or member); myRole
// is resolved per row from the same RPC, exactly as toPublicProject does for
// projects.
export async function listOrgs(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load organizations.");
  }

  const orgs = await Promise.all(
    ((data ?? []) as OrgRow[]).map(async (row) => {
      const { data: myRole } = await supabase.rpc("org_role", { p_org_id: row.id });
      return {
        id: row.id,
        name: row.name,
        myRole: (myRole as ProjectRole | null) ?? "viewer",
        createdAt: row.created_at,
      };
    }),
  );

  res.status(200).json({ orgs });
}

// GET /orgs/:id — a single org with its teams -> projects rollup. Teams embed
// their projects through the project_teams join table; RLS on both tables means an org
// member only ever sees the teams/projects they're entitled to (org members
// inherit at least viewer on every project in the org via project_role()).
export async function getOrg(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, created_at")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load organization.");
  }
  if (!data) {
    throw new HttpError(404, "Organization not found");
  }

  const [{ data: myRole }, { data: teamRows, error: teamsError }] = await Promise.all([
    supabase.rpc("org_role", { p_org_id: data.id }),
    supabase
      .from("teams")
      .select("id, name, created_at, project_teams ( projects ( id, name, status ) )")
      .eq("org_id", data.id)
      .order("created_at", { ascending: true }),
  ]);

  if (teamsError) {
    throw new HttpError(500, "Could not load teams for this organization.");
  }

  const teams = ((teamRows ?? []) as TeamRollupRow[]).map((team) => ({
    id: team.id,
    name: team.name,
    projects: (team.project_teams ?? [])
      .map((link) => (Array.isArray(link.projects) ? link.projects[0] : link.projects))
      .filter((p): p is RollupProject => p != null)
      .map((p) => ({ id: p.id, name: p.name, status: p.status })),
  }));

  res.status(200).json({
    org: {
      id: data.id,
      name: (data as OrgRow).name,
      myRole: (myRole as ProjectRole | null) ?? "viewer",
      createdAt: (data as OrgRow).created_at,
      teams,
    },
  });
}

export async function createOrg(req: Request, res: Response): Promise<void> {
  const { name } = req.body as CreateOrgInput;
  const supabase = userScopedClient(req);

  // Insert without chaining .select(): PostgREST would turn that into
  // INSERT ... RETURNING, which re-checks the organizations SELECT policy
  // (org_role(id) is not null) against the row from *this same* statement —
  // and org_role()'s own lookup into organizations can't see that
  // not-yet-committed row, so the RETURNING check spuriously fails with an
  // RLS violation even though the INSERT's own WITH CHECK passed. Same
  // gotcha, and same fix, as createProject: generate the id here and fetch
  // the row back separately once it's committed and visible normally.
  const orgId = randomUUID();
  const { error: insertError } = await supabase.from("organizations").insert({
    id: orgId,
    owner_id: req.user!.id,
    name,
  });

  if (insertError) {
    logger.error({ err: insertError, userId: req.user!.id }, "Could not create organization");
    throw new HttpError(500, "Could not create organization.");
  }

  const { data: org, error: fetchError } = await supabase
    .from("organizations")
    .select("id, name, created_at")
    .eq("id", orgId)
    .single();

  if (fetchError || !org) {
    throw new HttpError(500, "Organization created, but could not be loaded.");
  }

  await recordOrgActivity(supabase, {
    orgId,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "org",
    summary: `created the organization "${name}"`,
  });

  res.status(201).json({
    org: {
      id: org.id,
      name: org.name,
      myRole: "owner" as const,
      createdAt: org.created_at,
      teams: [],
    },
  });
}

// PATCH /orgs/:orgId — rename. Runs on the loadOrg-scoped router, so
// req.org.myRole is available. RLS also enforces owner/admin, but the explicit
// check gives a clean 403 instead of a silent zero-row update.
export async function updateOrg(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const { name } = req.body as UpdateOrgInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("organizations")
    .update({ name })
    .eq("id", org.id)
    .select("id, name")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this organization.");
  }
  if (!data) {
    throw new HttpError(404, "Organization not found");
  }

  await recordOrgActivity(supabase, {
    orgId: org.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "org",
    summary: `renamed the organization to "${data.name}"`,
  });

  res.status(200).json({ org: { id: data.id, name: data.name } });
}

// GET /orgs/:orgId/activity — latest audit events for the org. RLS already
// scopes reads to members; loadOrg has 404'd non-members before this runs.
export async function listOrgActivity(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("org_activity_events")
    .select("id, event_type, actor_label, summary, meta, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new HttpError(500, "Could not load organization activity.");
  }

  res.status(200).json({ activity: ((data ?? []) as OrgActivityEventRow[]).map(toPublicOrgActivityEvent) });
}

// DELETE /orgs/:orgId — owner-only (matches the organizations DELETE RLS
// policy). Cascades to teams, org/team members, invites, and the project_teams
// links for those teams (join rows are `on delete cascade`); the projects
// themselves are kept, just detached from the org's teams.
export async function deleteOrg(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  if (org.myRole !== "owner") {
    throw new HttpError(403, "Only the organization owner can delete it.");
  }
  const supabase = userScopedClient(req);

  // Same acknowledge-first guard as deleteTeam: report how many projects will
  // be detached (via the org's teams) unless the caller passed force.
  const { force } = (req.body ?? {}) as { force?: boolean };
  if (!force) {
    const { data: teamRows } = await supabase.from("teams").select("id").eq("org_id", org.id);
    const teamIds = (teamRows ?? []).map((t) => t.id);

    if (teamIds.length > 0) {
      const { count: linkCount } = await supabase
        .from("project_teams")
        .select("project_id", { count: "exact", head: true })
        .in("team_id", teamIds);

      if ((linkCount ?? 0) > 0) {
        throw new HttpError(409, `${linkCount} project assignment(s) will be removed with this organization.`, {
          projectCount: linkCount,
        });
      }
    }
  }

  const { error, count } = await supabase.from("organizations").delete({ count: "exact" }).eq("id", org.id);

  if (error) {
    throw new HttpError(500, "Could not delete this organization.");
  }
  if (!count) {
    throw new HttpError(404, "Organization not found");
  }

  res.status(204).send();
}
