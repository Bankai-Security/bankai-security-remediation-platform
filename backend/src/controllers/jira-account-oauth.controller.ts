import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { createJiraAccountOAuthAuthorizationUrl, getAtlassianAccessibleSites, getAtlassianProjects, jiraOAuthConfigured, loadJiraAccountOAuthCredentials } from "../lib/atlassian-oauth.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userClient(req: Request) { return createUserScopedSupabaseClient(req.accessToken as string); }

export function startJiraAccountOAuth(req: Request, res: Response): void {
  if (!jiraOAuthConfigured()) throw new HttpError(503, "Jira one-click authorization is not configured on the backend.");
  const returnTo = req.query.returnTo === "onboarding" ? "onboarding" : undefined;
  res.status(200).json({ authorizationUrl: createJiraAccountOAuthAuthorizationUrl(req.user!.id, returnTo) });
}

export async function getJiraAccountOAuthStatus(req: Request, res: Response): Promise<void> {
  const { data, error } = await userClient(req).from("profiles").select("jira_oauth_connected_at").eq("id", req.user!.id).single();
  if (error || !data) throw new HttpError(500, "Could not load your Jira account connection.");
  res.status(200).json({ connected: data.jira_oauth_connected_at !== null });
}

export async function disconnectJiraAccountOAuth(req: Request, res: Response): Promise<void> {
  const { error } = await userClient(req).from("profiles").update({
    jira_oauth_access_token_enc: null, jira_oauth_refresh_token_enc: null, jira_oauth_expires_at: null, jira_oauth_connected_at: null,
  }).eq("id", req.user!.id);
  if (error) throw new HttpError(500, "Could not disconnect your Jira account.");
  res.status(200).json({ connected: false });
}

export async function listJiraAccountOAuthSites(req: Request, res: Response): Promise<void> {
  const authorization = await loadJiraAccountOAuthCredentials(req.user!.id);
  if (!authorization) throw new HttpError(409, "Connect your Atlassian account first.");
  try { res.status(200).json({ sites: await getAtlassianAccessibleSites(authorization.accessToken) }); }
  catch { throw new HttpError(502, "Could not discover Jira sites. Reconnect Atlassian or check its site permissions."); }
}

export async function listJiraAccountOAuthProjects(req: Request, res: Response): Promise<void> {
  const cloudId = req.query.cloudId;
  if (typeof cloudId !== "string") throw new HttpError(400, "Choose a Jira site first.");
  const authorization = await loadJiraAccountOAuthCredentials(req.user!.id);
  if (!authorization) throw new HttpError(409, "Connect your Atlassian account first.");
  try {
    const sites = await getAtlassianAccessibleSites(authorization.accessToken);
    if (!sites.some((site) => site.id === cloudId)) throw new HttpError(403, "That Jira site is not available to this authorization.");
    res.status(200).json({ projects: await getAtlassianProjects(authorization.accessToken, cloudId) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not discover Jira projects. Check your Jira permissions and try again.");
  }
}

