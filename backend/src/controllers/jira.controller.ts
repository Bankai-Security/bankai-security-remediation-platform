import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { encrypt } from "../lib/crypto.js";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { JiraApiError, verifyConnection } from "../lib/jira.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { reconcileJiraTickets } from "../lib/ticketing.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { ConnectJiraInput } from "../schemas/jira.schema.js";
import type { SelectJiraOAuthProjectInput } from "../schemas/jira.schema.js";
import {
  createJiraOAuthAuthorizationUrl,
  exchangeJiraOAuthCode,
  getAtlassianAccessibleSites,
  getAtlassianProjects,
  jiraOAuthConfigured,
  loadJiraOAuthCredentials,
  parseJiraOAuthState,
  saveJiraOAuthTokens,
} from "../lib/atlassian-oauth.js";
import { supabaseAdmin } from "../lib/supabase.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface JiraConnectionRow {
  jira_site: string | null;
  jira_key: string | null;
  jira_email: string | null;
  jira_connected_at: string | null;
  jira_oauth_access_token_enc?: string | null;
  jira_cloud_id?: string | null;
}

function toPublicConnection(row: JiraConnectionRow) {
  return {
    connected: row.jira_connected_at !== null,
    site: row.jira_site,
    projectKey: row.jira_key,
    email: row.jira_email,
    connectedAt: row.jira_connected_at,
    oauthAuthorized: Boolean(row.jira_oauth_access_token_enc),
  };
}

export async function getJiraStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select("jira_site, jira_key, jira_email, jira_connected_at, jira_oauth_access_token_enc, jira_cloud_id")
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
      jira_oauth_access_token_enc: null,
      jira_oauth_refresh_token_enc: null,
      jira_oauth_expires_at: null,
      jira_cloud_id: null,
      jira_oauth_account_id: null,
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
      jira_oauth_access_token_enc: null,
      jira_oauth_refresh_token_enc: null,
      jira_oauth_expires_at: null,
      jira_cloud_id: null,
      jira_oauth_account_id: null,
      jira_connected_at: null,
    })
    .eq("id", project.id)
    .select("jira_site, jira_key, jira_email, jira_connected_at, jira_oauth_access_token_enc, jira_cloud_id")
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

function callbackUrl(projectId: string, result: "connected" | "error"): string {
  const url = new URL(`/workspace/${encodeURIComponent(projectId)}/settings`, env.FRONTEND_ORIGIN);
  url.searchParams.set("jiraOAuth", result);
  return url.toString();
}

export async function startJiraOAuth(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  if (!jiraOAuthConfigured()) throw new HttpError(503, "Jira one-click authorization is not configured. Use the API-token fallback or configure Atlassian OAuth on the backend.");
  const authorizationUrl = createJiraOAuthAuthorizationUrl(req.project!.id, req.user!.id);
  res.status(200).json({ authorizationUrl });
}

export async function jiraOAuthCallback(req: Request, res: Response): Promise<void> {
  const state = typeof req.query.state === "string" ? parseJiraOAuthState(req.query.state) : null;
  if (!state) { res.status(400).send("Jira authorization could not be verified. Return to Bankai and try again."); return; }
  if (typeof req.query.error === "string" || typeof req.query.code !== "string") { res.redirect(callbackUrl(state.projectId, "error")); return; }

  const [{ data: project }, { data: membership }] = await Promise.all([
    supabaseAdmin.from("projects").select("id,owner_id").eq("id", state.projectId).maybeSingle(),
    supabaseAdmin.from("project_members").select("role").eq("project_id", state.projectId).eq("user_id", state.userId).maybeSingle(),
  ]);
  const role = project?.owner_id === state.userId ? "owner" : membership?.role;
  if (!project || !["owner", "admin"].includes(role ?? "")) { res.redirect(callbackUrl(state.projectId, "error")); return; }

  try {
    const pair = await exchangeJiraOAuthCode(req.query.code);
    await saveJiraOAuthTokens(supabaseAdmin, state.projectId, pair);
    res.redirect(callbackUrl(state.projectId, "connected"));
  } catch {
    res.redirect(callbackUrl(state.projectId, "error"));
  }
}

export async function listJiraOAuthSites(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  const authorization = await loadJiraOAuthCredentials(req.project!.id);
  if (!authorization) throw new HttpError(409, "Connect Jira with Atlassian first.");
  try {
    const sites = await getAtlassianAccessibleSites(authorization.accessToken);
    res.status(200).json({ sites });
  } catch { throw new HttpError(502, "Could not discover Jira sites. Reconnect Atlassian or check its site permissions."); }
}

export async function listJiraOAuthProjects(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  const cloudId = req.query.cloudId;
  if (typeof cloudId !== "string") throw new HttpError(400, "Choose a Jira site first.");
  const authorization = await loadJiraOAuthCredentials(req.project!.id);
  if (!authorization) throw new HttpError(409, "Connect Jira with Atlassian first.");
  try {
    const sites = await getAtlassianAccessibleSites(authorization.accessToken);
    if (!sites.some((site) => site.id === cloudId)) throw new HttpError(403, "That Jira site is not available to this authorization.");
    const projects = await getAtlassianProjects(authorization.accessToken, cloudId);
    res.status(200).json({ projects });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not discover Jira projects. Check your Jira permissions and try again.");
  }
}

export async function selectJiraOAuthProject(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { cloudId, projectKey } = req.body as SelectJiraOAuthProjectInput;
  const authorization = await loadJiraOAuthCredentials(project.id);
  if (!authorization) throw new HttpError(409, "Connect Jira with Atlassian first.");

  let site: string;
  try {
    const sites = await getAtlassianAccessibleSites(authorization.accessToken);
    const selectedSite = sites.find((item) => item.id === cloudId);
    if (!selectedSite) throw new HttpError(403, "That Jira site is not available to this authorization.");
    const jiraProject = (await getAtlassianProjects(authorization.accessToken, cloudId)).find((item) => item.key === projectKey);
    if (!jiraProject) throw new HttpError(422, `Project key "${projectKey}" is not available on the selected Jira site.`);
    site = new URL(selectedSite.url).hostname;
    await verifyConnection({ site, cloudId, accessToken: authorization.accessToken }, projectKey);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof JiraApiError) throw new HttpError(422, error.message);
    throw new HttpError(502, "Could not verify the selected Jira project.");
  }

  const supabase = userScopedClient(req);
  const { data, error } = await supabase.from("projects").update({
    jira_site: site,
    jira_key: projectKey,
    jira_email: null,
    jira_api_token_enc: null,
    jira_cloud_id: cloudId,
    jira_connected_at: new Date().toISOString(),
  }).eq("id", project.id)
    .select("jira_site,jira_key,jira_email,jira_connected_at,jira_oauth_access_token_enc,jira_cloud_id")
    .single();
  if (error || !data) throw new HttpError(500, "Could not save the Jira site and project selection.");

  await recordActivity(supabase, { projectId: project.id, actorId: req.user!.id, actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket", summary: "connected Jira with Atlassian OAuth", linkLabel: projectKey, linkTo: "settings", meta: site });
  const { reconciled, imported } = await reconcileJiraTickets(supabase, {
    projectId: project.id,
    jira: { creds: { site, cloudId, accessToken: authorization.accessToken }, projectKey },
    actor: { id: req.user!.id, label: displayNameFromUser(req.user!) },
    rpcName: "create_project_ticket",
    slaPolicyDays: project.slaPolicyDays,
  });
  res.status(200).json({ ...toPublicConnection(data as JiraConnectionRow), reconciled, imported });
}
