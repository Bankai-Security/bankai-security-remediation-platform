import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import type { ProjectRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

// Resolves :teamId into req.team for routes nested under
// /api/orgs/:orgId/teams/:teamId/*. Mirrors loadOrg/loadProject: RLS on the
// teams table means a team this user can't see simply won't come back, so a
// missing row is a plain 404 (no info leaked). Uses the user-scoped client
// only — never the service-role client.
export async function loadTeam(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const supabase = createUserScopedSupabaseClient(req.accessToken as string);
  const { data, error } = await supabase
    .from("teams")
    .select("id, name, org_id")
    .eq("id", req.params.teamId)
    .maybeSingle();

  if (error) {
    next(new HttpError(500, "Could not load team."));
    return;
  }
  // Guard against a team id from a different org being addressed through this
  // org's URL — treat as not found rather than leaking cross-org existence.
  if (!data || data.org_id !== req.params.orgId) {
    next(new HttpError(404, "Team not found"));
    return;
  }

  const { data: role, error: roleError } = await supabase.rpc("team_role", { p_team_id: data.id });
  if (roleError || !role) {
    next(new HttpError(404, "Team not found"));
    return;
  }

  req.team = {
    id: data.id,
    name: data.name,
    orgId: data.org_id,
    myRole: role as ProjectRole,
  };
  next();
}
