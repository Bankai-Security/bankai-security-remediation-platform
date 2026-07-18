import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { computeProjectStats } from "../lib/project-stats.js";
import type { ProjectRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateProjectInput, DeleteProjectInput } from "../schemas/project.schema.js";

const PROJECT_COLUMNS =
  "id, name, description, jira_site, jira_key, jira_connected_at, sla_critical_days, sla_high_days, sla_medium_days, sla_low_days, status, created_at";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
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
  return {
    id: row.id,
    name: row.name,
    description: row.description,
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

export async function createProject(req: Request, res: Response): Promise<void> {
  const { name, description, services } = req.body as CreateProjectInput;
  const supabase = userScopedClient(req);

  const { data: project, error: insertError } = await supabase
    .from("projects")
    .insert({
      owner_id: req.user!.id,
      name,
      description: description || null,
      key_prefix: deriveKeyPrefix(name),
    })
    .select(PROJECT_COLUMNS)
    .single();

  if (insertError || !project) {
    throw new HttpError(500, "Could not create project.");
  }

  let serviceNames: string[] = [];
  if (services.length > 0) {
    const { data: insertedServices, error: servicesError } = await supabase
      .from("project_services")
      .insert(services.map((serviceName) => ({ project_id: project.id, name: serviceName })))
      .select("name");

    if (servicesError) {
      throw new HttpError(500, "Project created, but services could not be saved.");
    }
    serviceNames = (insertedServices ?? []).map((s) => s.name);
  }

  res.status(201).json({
    project: await toPublicProject(supabase, { ...project, project_services: serviceNames.map((n) => ({ name: n })) }),
  });
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
    .select("id, name, owner_id")
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

  const { error, count } = await supabase.from("projects").delete({ count: "exact" }).eq("id", project.id);

  if (error) {
    throw new HttpError(500, "Could not delete this project.");
  }
  if (!count) {
    throw new HttpError(404, "Project not found");
  }

  res.status(204).send();
}
