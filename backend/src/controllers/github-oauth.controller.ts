import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { baseCookieOptions } from "../lib/auth-cookies.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getAuthenticatedGithubUser,
  listAuthenticatedUserRepos,
} from "../lib/github-oauth.js";
import { GithubApiError } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

const STATE_COOKIE = "bankai_gh_oauth_state";
const STATE_MAX_AGE_MS = 5 * 60 * 1000;

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

// Kicks off the OAuth redirect. Real navigation (the frontend sets
// window.location, not fetch), so this always ends in a redirect — never a
// JSON error — GitHub is the next hop.
export function authorizeGithubAccount(_req: Request, res: Response): void {
  const state = randomBytes(24).toString("hex");
  res.cookie(STATE_COOKIE, state, { ...baseCookieOptions(), maxAge: STATE_MAX_AGE_MS });
  res.redirect(buildAuthorizeUrl(state));
}

// The callback is also a top-level browser navigation (GitHub redirecting
// back), so — same as authorize — every path here ends in a redirect to the
// frontend, never a raw JSON error response, which the browser would just
// render as a blank/ugly page.
export async function githubAccountCallback(req: Request, res: Response): Promise<void> {
  const redirectTo = (status: "connected" | "error") => res.redirect(`${env.FRONTEND_ORIGIN}/settings?github_account=${status}`);

  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const expectedState = cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookieOptions());

  const { code, state, error: oauthError } = req.query;
  if (oauthError) {
    // User declined the authorization on GitHub's consent screen — not a
    // bug, nothing to log as an error.
    redirectTo("error");
    return;
  }
  if (!expectedState || typeof state !== "string" || state !== expectedState || typeof code !== "string") {
    logger.warn({ hasState: !!state, hasExpected: !!expectedState }, "GitHub OAuth callback failed state verification");
    redirectTo("error");
    return;
  }

  try {
    const { token, scope } = await exchangeCodeForToken(code);
    const identity = await getAuthenticatedGithubUser(token);

    const supabase = userScopedClient(req);
    const { error: dbError } = await supabase
      .from("profiles")
      .update({
        github_user_id: identity.id,
        github_login: identity.login,
        github_user_token_enc: encrypt(token),
        github_oauth_scope: scope,
        github_oauth_connected_at: new Date().toISOString(),
      })
      .eq("id", req.user!.id);

    if (dbError) {
      logger.error({ err: dbError, userId: req.user!.id }, "Could not persist GitHub account connection");
      redirectTo("error");
      return;
    }

    redirectTo("connected");
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, "GitHub OAuth callback failed");
    redirectTo("error");
  }
}

interface GithubIdentityRow {
  github_login: string | null;
  github_oauth_connected_at: string | null;
}

export async function getGithubAccountStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("profiles")
    .select("github_login, github_oauth_connected_at")
    .eq("id", req.user!.id)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not load your GitHub account connection.");
  }

  const row = data as GithubIdentityRow;
  res.status(200).json({ connected: row.github_oauth_connected_at !== null, login: row.github_login });
}

export async function disconnectGithubAccount(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { error } = await supabase
    .from("profiles")
    .update({
      github_user_id: null,
      github_login: null,
      github_user_token_enc: null,
      github_oauth_scope: null,
      github_oauth_connected_at: null,
    })
    .eq("id", req.user!.id);

  if (error) {
    throw new HttpError(500, "Could not disconnect your GitHub account.");
  }

  res.status(200).json({ connected: false, login: null });
}

interface GithubTokenRow {
  github_user_token_enc: string | null;
}

export async function listMyGithubRepos(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("profiles")
    .select("github_user_token_enc")
    .eq("id", req.user!.id)
    .single();

  const row = data as GithubTokenRow | null;
  if (error || !row?.github_user_token_enc) {
    throw new HttpError(422, "Connect your GitHub account in Settings first.");
  }

  try {
    const repos = await listAuthenticatedUserRepos(decrypt(row.github_user_token_enc));
    res.status(200).json({ repos });
  } catch (err) {
    if (err instanceof GithubApiError) {
      throw new HttpError(err.status === 401 ? 401 : 502, err.message);
    }
    throw new HttpError(502, "Could not reach GitHub. Please try again.");
  }
}
