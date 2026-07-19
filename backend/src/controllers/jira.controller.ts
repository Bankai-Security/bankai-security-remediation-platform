import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { encrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/http-error.js";
import { JiraApiError, verifyConnection } from "../lib/jira.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { reconcileJiraTickets } from "../lib/ticketing.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { ConnectJiraInput } from "../schemas/jira.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface JiraConnectionRow {
  jira_site: string | null;
  jira_key: string | null;
  jira_email: string | null;
  jira_connected_at: string | null;
}

function toPublicConnection(row: JiraConnectionRow) {
  return {
    connected: row.jira_connected_at !== null,
    site: row.jira_site,
    projectKey: row.jira_key,
    email: row.jira_email,
    connectedAt: row.jira_connected_at,
  };
}

export async function getJiraStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select("jira_site, jira_key, jira_email, jira_connected_at")
    .eq("id", req.project!.id)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not load this project's Jira connection.");
  }

  res.status(200).json(toPublicConnection(data as JiraConnectionRow));
}

export async function connectJira(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { site, email, apiToken, projectKey } = req.body as ConnectJiraInput;
  const supabase = userScopedClient(req);

  try {
    await verifyConnection({ site, email, apiToken }, projectKey);
  } catch (err) {
    if (err instanceof JiraApiError) {
      throw new HttpError(422, err.message);
    }
    throw new HttpError(502, "Could not reach Jira. Please try again.");
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      jira_site: site,
      jira_key: projectKey,
      jira_email: email,
      jira_api_token_enc: encrypt(apiToken),
      jira_connected_at: new Date().toISOString(),
    })
    .eq("id", project.id)
    .select("jira_site, jira_key, jira_email, jira_connected_at")
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not save this Jira connection.");
  }

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket",
    summary: "connected Jira",
    linkLabel: projectKey,
    linkTo: "settings",
    meta: site,
  });

  // Best-effort: if another Bankai project (this account or a different
  // one) already created Jira issues in this same Jira project for
  // findings this project also knows about, link to them instead of
  // leaving this project to create duplicates the first time it creates
  // tickets. Uses the credentials just submitted/verified above rather
  // than round-tripping through loadJiraCreds/decrypt.
  const { reconciled, imported } = await reconcileJiraTickets(supabase, {
    projectId: project.id,
    jira: { creds: { site, email, apiToken }, projectKey },
    actor: { id: req.user!.id, label: displayNameFromUser(req.user!) },
    rpcName: "create_project_ticket",
    slaPolicyDays: project.slaPolicyDays,
  });

  res.status(200).json({ ...toPublicConnection(data as JiraConnectionRow), reconciled, imported });
}

export async function disconnectJira(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("projects")
    .update({
      jira_site: null,
      jira_key: null,
      jira_email: null,
      jira_api_token_enc: null,
      jira_connected_at: null,
    })
    .eq("id", project.id)
    .select("jira_site, jira_key, jira_email, jira_connected_at")
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not disconnect Jira.");
  }

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket",
    summary: "disconnected Jira",
  });

  res.status(200).json(toPublicConnection(data as JiraConnectionRow));
}
