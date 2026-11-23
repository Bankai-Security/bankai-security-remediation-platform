import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { decrypt, encrypt } from "./crypto.js";
import { supabaseAdmin } from "./supabase.js";

const AUTH_ROOT = "https://auth.atlassian.com";
const API_ROOT = "https://api.atlassian.com";
const OAUTH_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"];
const refreshes = new Map<string, Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>>();

export interface AtlassianSite { id: string; name: string; url: string; scopes: string[] }
export interface AtlassianProject { id: string; key: string; name: string; projectTypeKey?: string }
export interface AtlassianTokenPair { accessToken: string; refreshToken: string; expiresAt: string; scope?: string }

interface OAuthState { projectId: string; userId: string; expiresAt: number; nonce: string; returnTo?: "onboarding" }

function signingKey(): Buffer {
  const key = Buffer.from(env.TOKEN_ENC_KEY, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must decode to exactly 32 bytes.");
  return key;
}

export function jiraOAuthConfigured(): boolean {
  return Boolean(env.ATLASSIAN_OAUTH_CLIENT_ID && env.ATLASSIAN_OAUTH_CLIENT_SECRET);
}

export function jiraOAuthRedirectUri(): string {
  return env.ATLASSIAN_OAUTH_REDIRECT_URI
    ?? `${(env.BACKEND_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "")}/api/jira/oauth/callback`;
}

export function createJiraOAuthAuthorizationUrl(projectId: string, userId: string, returnTo?: "onboarding"): string {
  if (!jiraOAuthConfigured()) throw new Error("Jira Cloud OAuth is not configured.");
  const state: OAuthState = { projectId, userId, expiresAt: Date.now() + 10 * 60_000, nonce: randomBytes(18).toString("base64url"), ...(returnTo ? { returnTo } : {}) };
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  const url = new URL(`${AUTH_ROOT}/authorize`);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", env.ATLASSIAN_OAUTH_CLIENT_ID!);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", jiraOAuthRedirectUri());
  url.searchParams.set("state", `${encoded}.${signature}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export function parseJiraOAuthState(value: string): OAuthState | null {
  const [encoded, provided, extra] = value.split(".");
  if (!encoded || !provided || extra) return null;
  const expected = createHmac("sha256", signingKey()).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(provided, "base64url"); } catch { return null; }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthState;
    if (!state.projectId || !state.userId || !state.nonce || !Number.isFinite(state.expiresAt) || state.expiresAt < Date.now()) return null;
    return state;
  } catch { return null; }
}

function tokenPair(payload: Record<string, unknown>): AtlassianTokenPair {
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string" || typeof payload.expires_in !== "number") {
    throw new Error("Atlassian did not return a usable access and refresh token pair.");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(30, payload.expires_in - 60) * 1000).toISOString(),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<AtlassianTokenPair> {
  if (!jiraOAuthConfigured()) throw new Error("Jira Cloud OAuth is not configured.");
  const response = await fetch(`${AUTH_ROOT}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...body, client_id: env.ATLASSIAN_OAUTH_CLIENT_ID, client_secret: env.ATLASSIAN_OAUTH_CLIENT_SECRET }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Atlassian token exchange failed (HTTP ${response.status}).`);
  return tokenPair(await response.json() as Record<string, unknown>);
}

export function exchangeJiraOAuthCode(code: string): Promise<AtlassianTokenPair> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: jiraOAuthRedirectUri() });
}

export async function getAtlassianAccessibleSites(accessToken: string): Promise<AtlassianSite[]> {
  const response = await fetch(`${API_ROOT}/oauth/token/accessible-resources`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Atlassian site discovery failed (HTTP ${response.status}).`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error("Atlassian returned an invalid site list.");
  return value.filter((row): row is AtlassianSite => Boolean(row && typeof row === "object"
    && typeof (row as AtlassianSite).id === "string" && typeof (row as AtlassianSite).name === "string"
    && typeof (row as AtlassianSite).url === "string"));
}

export async function getAtlassianProjects(accessToken: string, cloudId: string): Promise<AtlassianProject[]> {
  const projects: AtlassianProject[] = [];
  for (let startAt = 0; startAt < 500; startAt += 100) {
    const url = new URL(`${API_ROOT}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/project/search`);
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", "100");
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Jira project discovery failed (HTTP ${response.status}).`);
    const body = await response.json() as { values?: AtlassianProject[]; isLast?: boolean };
    projects.push(...(body.values ?? []));
    if (body.isLast === true || !body.values?.length) break;
  }
  return projects.filter((item) => typeof item.key === "string" && typeof item.name === "string");
}

export async function saveJiraOAuthTokens(supabase: SupabaseClient, projectId: string, pair: AtlassianTokenPair): Promise<void> {
  const { error } = await supabase.from("projects").update({
    jira_oauth_access_token_enc: encrypt(pair.accessToken),
    jira_oauth_refresh_token_enc: encrypt(pair.refreshToken),
    jira_oauth_expires_at: pair.expiresAt,
    jira_site: null,
    jira_key: null,
    jira_email: null,
    jira_api_token_enc: null,
    jira_cloud_id: null,
    jira_oauth_account_id: null,
    jira_connected_at: null,
  }).eq("id", projectId);
  if (error) throw new Error("Could not securely save the Jira authorization.");
}

export async function loadJiraOAuthCredentials(projectId: string): Promise<{
  accessToken: string; cloudId: string | null; site: string | null; refreshTokenPresent: boolean;
} | null> {
  const { data, error } = await supabaseAdmin.from("projects")
    .select("jira_oauth_access_token_enc,jira_oauth_refresh_token_enc,jira_oauth_expires_at,jira_cloud_id,jira_site")
    .eq("id", projectId).maybeSingle();
  if (error) throw new Error("Could not load Jira authorization state.");
  const row = data as { jira_oauth_access_token_enc: string | null; jira_oauth_refresh_token_enc: string | null; jira_oauth_expires_at: string | null; jira_cloud_id: string | null; jira_site: string | null } | null;
  if (!row?.jira_oauth_access_token_enc) return null;
  let accessToken = decrypt(row.jira_oauth_access_token_enc);
  let refreshToken: string | null = row.jira_oauth_refresh_token_enc ? decrypt(row.jira_oauth_refresh_token_enc) : null;
  const expiry = row.jira_oauth_expires_at ? Date.parse(row.jira_oauth_expires_at) : 0;
  if (expiry <= Date.now() + 30_000) {
    if (!refreshToken) return null;
    let refresh = refreshes.get(projectId);
    if (!refresh) {
      refresh = tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      refreshes.set(projectId, refresh);
      void refresh.finally(() => refreshes.delete(projectId)).catch(() => undefined);
    }
    const pair = await refresh;
    accessToken = pair.accessToken;
    refreshToken = pair.refreshToken;
    const { error: saveError } = await supabaseAdmin.from("projects").update({
      jira_oauth_access_token_enc: encrypt(accessToken),
      jira_oauth_refresh_token_enc: encrypt(refreshToken),
      jira_oauth_expires_at: pair.expiresAt,
    }).eq("id", projectId);
    if (saveError) throw new Error("Could not rotate the Jira refresh token securely.");
  }
  return { accessToken, cloudId: row.jira_cloud_id, site: row.jira_site, refreshTokenPresent: Boolean(refreshToken) };
}

export function jiraApiRoot(cloudId: string): string {
  return `${API_ROOT}/ex/jira/${encodeURIComponent(cloudId)}`;
}
