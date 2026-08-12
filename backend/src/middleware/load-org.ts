import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import type { ProjectRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

// Resolves :orgId into req.org for every route nested under
// /api/orgs/:orgId/*. Exactly like loadProject: RLS on the organizations
// table means an org this user has no access to simply won't come back, so a
// missing row is reported as a plain 404 rather than a 403 (no membership
// info leaked). Uses the user-scoped client only — never the service-role
// client — so access is enforced by RLS, not re-implemented here.
export async function loadOrg(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const supabase = createUserScopedSupabaseClient(req.accessToken as string);
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, owner_id")
    .eq("id", req.params.orgId)
    .maybeSingle();

  if (error) {
    next(new HttpError(500, "Could not load organization."));
    return;
  }
  if (!data) {
    next(new HttpError(404, "Organization not found"));
    return;
  }

  // Same function RLS itself calls to decide whether the row above was even
  // visible — one source of truth for "what's my role here," not a second
  // implementation in TypeScript that could drift from it. org_role() folds
  // in nothing extra (an org has no parent), but keeping the shape identical
  // to loadProject means the effective-role wiring stays uniform.
  const { data: role, error: roleError } = await supabase.rpc("org_role", { p_org_id: data.id });
  if (roleError || !role) {
    next(new HttpError(404, "Organization not found"));
    return;
  }

  req.org = {
    id: data.id,
    name: data.name,
    ownerId: data.owner_id,
    myRole: role as ProjectRole,
  };
  next();
}
