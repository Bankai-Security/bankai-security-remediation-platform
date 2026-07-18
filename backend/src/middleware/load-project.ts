import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import type { ProjectRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

// Resolves :projectId into req.project for every route nested under
// /api/projects/:projectId/*. RLS on the projects table means a project
// this user has no access to simply won't come back, so a missing row is
// reported as a plain 404 rather than a 403 (no ownership info leaked).
export async function loadProject(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const supabase = createUserScopedSupabaseClient(req.accessToken as string);
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, key_prefix, owner_id, sla_critical_days, sla_high_days, sla_medium_days, sla_low_days")
    .eq("id", req.params.projectId)
    .maybeSingle();

  if (error) {
    next(new HttpError(500, "Could not load project."));
    return;
  }
  if (!data) {
    next(new HttpError(404, "Project not found"));
    return;
  }

  // Same function RLS itself calls to decide whether the row above was
  // even visible — one source of truth for "what's my role here," not a
  // second implementation in TypeScript that could drift from it.
  const { data: role, error: roleError } = await supabase.rpc("project_role", { p_project_id: data.id });
  if (roleError || !role) {
    next(new HttpError(404, "Project not found"));
    return;
  }

  req.project = {
    id: data.id,
    name: data.name,
    keyPrefix: data.key_prefix,
    ownerId: data.owner_id,
    slaPolicyDays: {
      Critical: data.sla_critical_days,
      High: data.sla_high_days,
      Medium: data.sla_medium_days,
      Low: data.sla_low_days,
    },
    myRole: role as ProjectRole,
  };
  next();
}
