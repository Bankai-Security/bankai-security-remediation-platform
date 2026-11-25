import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { createJiraAccountOAuthAuthorizationUrl, jiraOAuthConfigured } from "../lib/atlassian-oauth.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userClient(req: Request) { return createUserScopedSupabaseClient(req.accessToken as string); }

export function startJiraAccountOAuth(req: Request, res: Response): void {
  if (!jiraOAuthConfigured()) throw new HttpError(503, "Jira one-click authorization is not configured on the backend.");
  res.status(200).json({ authorizationUrl: createJiraAccountOAuthAuthorizationUrl(req.user!.id) });
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

