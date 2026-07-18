import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTokenParam(req: Request): string {
  const { token } = req.params;
  if (typeof token !== "string" || !UUID_RE.test(token)) {
    throw new HttpError(404, "Invite not found");
  }
  return token;
}

interface InviteRow {
  id: string;
  token?: string;
  role: "admin" | "editor" | "viewer";
  status: string;
  created_at: string;
  projects: { id: string; name: string } | { id: string; name: string }[] | null;
}

function projectOf(row: InviteRow) {
  return Array.isArray(row.projects) ? row.projects[0] : row.projects;
}

// The RLS select policy on project_invites is an OR — admin-of-project OR
// invitee-by-email — so an admin who queries this table also sees their
// own project's invites (meant for other people). This endpoint is "my
// invites," so it must filter by the caller's own email explicitly rather
// than trusting RLS to have already scoped it correctly.
export async function listMyInvites(req: Request, res: Response): Promise<void> {
  const email = req.user!.email?.toLowerCase();
  if (!email) {
    res.status(200).json({ invites: [] });
    return;
  }

  const supabase = userScopedClient(req);
  // Includes the token — safe here, since this endpoint only ever returns
  // invites matching the caller's own email (the RLS select policy plus
  // the explicit .eq("email", ...) above both gate on it), and the token
  // is exactly what they need to call accept/decline directly.
  const { data, error } = await supabase
    .from("project_invites")
    .select("id, token, role, status, created_at, projects ( id, name )")
    .eq("email", email)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load your invites.");
  }

  const invites = (data as unknown as InviteRow[]).map((row) => {
    const project = projectOf(row);
    return {
      id: row.id,
      token: row.token,
      projectId: project?.id ?? null,
      projectName: project?.name ?? "Unknown project",
      role: row.role,
      createdAt: row.created_at,
    };
  });

  res.status(200).json({ invites });
}

export async function getInviteByToken(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("project_invites")
    .select("id, role, status, created_at, projects ( id, name )")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load this invite.");
  }
  // RLS only returns this row if the caller's own email matches — a
  // no-match and a real 404 look identical to the caller either way.
  if (!data) {
    throw new HttpError(404, "Invite not found");
  }

  const row = data as unknown as InviteRow;
  const project = projectOf(row);
  res.status(200).json({
    id: row.id,
    projectId: project?.id ?? null,
    projectName: project?.name ?? "Unknown project",
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  });
}

export async function acceptInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase.rpc("accept_project_invite", { p_token: token });

  if (error || !data) {
    if (error?.code === "P0002") {
      throw new HttpError(404, "Invite not found");
    }
    if (error?.code === "42501") {
      throw new HttpError(403, "This invite was sent to a different email address.");
    }
    if (error?.code === "22023") {
      throw new HttpError(409, "This invite is no longer pending.");
    }
    throw new HttpError(500, "Could not accept this invite.");
  }

  res.status(200).json({ projectId: (data as { project_id: string }).project_id });
}

export async function declineInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { error, count } = await supabase
    .from("project_invites")
    .update({ status: "declined", responded_at: new Date().toISOString() }, { count: "exact" })
    .eq("token", token)
    .eq("status", "pending");

  if (error) {
    throw new HttpError(500, "Could not decline this invite.");
  }
  if (!count) {
    throw new HttpError(404, "Invite not found");
  }

  res.status(204).send();
}
