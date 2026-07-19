import { createClient, type Session, type SupportedStorage } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { ssoArcjet } from "../lib/arcjet.js";
import { baseCookieOptions, setAuthCookies } from "../lib/auth-cookies.js";
import { encrypt } from "../lib/crypto.js";
import { assertArcjetAllowed } from "../lib/enforce-arcjet.js";
import { getAuthenticatedGithubUser } from "../lib/github-oauth.js";
import { logger } from "../lib/logger.js";
import { GITHUB_SSO_SCOPES, isSsoProvider, ssoCallbackUrl } from "../lib/sso.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

const VERIFIER_COOKIE = "bankai_sso_verifier";
const PROVIDER_COOKIE = "bankai_sso_provider";
const VERIFIER_MAX_AGE_MS = 5 * 60 * 1000;

// A PKCE code verifier only needs to survive from the authorize request to
// the callback request, one value, never read/written again after — so a
// single cookie-backed slot stands in for supabase-js's usual
// localStorage-backed SupportedStorage, which doesn't exist on the server.
//
// Must be scoped to the `-code-verifier` key specifically, not "whatever key
// is asked for": with persistSession true, the client also calls
// getItem(this.storageKey) (no suffix) once on construction to recover an
// existing full session. Returning the verifier for that lookup too made it
// misread the verifier string as a serialized Session object and crash
// trying to set `.user` on a string.
function singleValueStorage(initial: string | null, onWrite: (value: string) => void): SupportedStorage {
  return {
    isServer: true,
    getItem: async (key) => (key.endsWith("-code-verifier") ? initial : null),
    setItem: async (key, value) => {
      if (key.endsWith("-code-verifier")) onWrite(value);
    },
    removeItem: async () => {},
  };
}

function pkceClient(storage: SupportedStorage) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      // Must be true, even though this client is single-use and discarded
      // at the end of the request — supabase-js only wires up a custom
      // `storage` adapter when persistSession is true; with it false, it
      // silently substitutes its own throwaway in-memory store instead
      // (GoTrueClient's constructor), so the PKCE code verifier written
      // during signInWithOAuth would never reach our cookie. No actual
      // browser storage is involved, so "persisting" here just means
      // "route reads/writes through singleValueStorage instead of memory".
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage,
    },
  });
}

// Kicks off the OAuth redirect. Real navigation (the frontend sets
// window.location, not fetch), so this always ends in a redirect — never a
// JSON error — the provider's consent screen is the next hop.
export async function authorizeSso(req: Request, res: Response): Promise<void> {
  const redirectToLogin = () => res.redirect(`${env.FRONTEND_ORIGIN}/login?sso_error=1`);

  const { provider } = req.params;
  if (typeof provider !== "string" || !isSsoProvider(provider)) {
    redirectToLogin();
    return;
  }

  try {
    const decision = await ssoArcjet.protect(req);
    assertArcjetAllowed(decision);
  } catch (err) {
    logger.warn({ err, provider }, "SSO authorize blocked by Arcjet");
    redirectToLogin();
    return;
  }

  let verifier: string | null = null;
  const supabase = pkceClient(
    singleValueStorage(null, (value) => {
      verifier = value;
    }),
  );

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: ssoCallbackUrl(),
      skipBrowserRedirect: true,
      // Widened only for GitHub so the same login grant doubles as the
      // "Connect GitHub account" repo-scanning grant — see the auto-connect
      // step in ssoCallback below.
      ...(provider === "github" ? { scopes: GITHUB_SSO_SCOPES } : {}),
    },
  });

  if (error || !data.url || !verifier) {
    logger.error({ err: error, provider }, "Could not start SSO sign-in");
    redirectToLogin();
    return;
  }

  res.cookie(VERIFIER_COOKIE, verifier, { ...baseCookieOptions(), maxAge: VERIFIER_MAX_AGE_MS });
  // The callback route is shared by every provider, so it has no other way
  // to know which one this is — app_metadata.provider on the resulting user
  // reflects the *first* provider they ever signed up with, not this
  // sign-in, so it can't be used for that (e.g. an existing email/password
  // user linking GitHub later would still show "email").
  res.cookie(PROVIDER_COOKIE, provider, { ...baseCookieOptions(), maxAge: VERIFIER_MAX_AGE_MS });
  res.redirect(data.url);
}

// A GitHub SSO login (requested with GITHUB_SSO_SCOPES) already proves
// account ownership and already carries repo access, so it doubles as the
// "Connect GitHub account" grant from github-oauth.controller.ts — same
// profiles columns, same shape, just sourced from session.provider_token
// instead of that flow's standalone OAuth App exchange. Never allowed to
// fail the login itself: worst case the user falls back to connecting
// GitHub manually in Settings, same as every non-GitHub-SSO user already
// does.
async function autoConnectGithub(session: Session): Promise<void> {
  if (!session.provider_token) {
    // Not guaranteed on every GitHub sign-in — Supabase only returns it
    // once, immediately after a fresh OAuth code exchange. Nothing to
    // (re)connect this time; whatever was stored before stays as-is.
    return;
  }

  try {
    const identity = await getAuthenticatedGithubUser(session.provider_token);
    const scoped = createUserScopedSupabaseClient(session.access_token);
    const { error } = await scoped
      .from("profiles")
      .update({
        github_user_id: identity.id,
        github_login: identity.login,
        github_user_token_enc: encrypt(session.provider_token),
        github_oauth_scope: GITHUB_SSO_SCOPES,
        github_oauth_connected_at: new Date().toISOString(),
      })
      .eq("id", session.user.id);

    if (error) {
      logger.warn({ err: error }, "Could not auto-connect GitHub repos from SSO login");
    }
  } catch (err) {
    logger.warn({ err }, "Could not auto-connect GitHub repos from SSO login");
  }
}

// Supabase (GoTrue) redirects back here after the provider's consent
// screen, with ?code=... to exchange for a session, or ?error=... if the
// user declined. Also a top-level navigation, so — same as authorize —
// every path here ends in a redirect to the frontend, never raw JSON.
export async function ssoCallback(req: Request, res: Response): Promise<void> {
  const redirectToError = () => res.redirect(`${env.FRONTEND_ORIGIN}/login?sso_error=1`);

  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const verifier = cookies?.[VERIFIER_COOKIE];
  const provider = cookies?.[PROVIDER_COOKIE];
  res.clearCookie(VERIFIER_COOKIE, baseCookieOptions());
  res.clearCookie(PROVIDER_COOKIE, baseCookieOptions());

  const { code, error: oauthError } = req.query;
  if (oauthError) {
    // User declined the authorization on the provider's consent screen —
    // not a bug, nothing to log as an error.
    redirectToError();
    return;
  }
  if (!verifier || typeof code !== "string") {
    logger.warn({ hasVerifier: !!verifier, hasCode: typeof code === "string" }, "SSO callback missing verifier or code");
    redirectToError();
    return;
  }

  try {
    const supabase = pkceClient(singleValueStorage(verifier, () => {}));
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      logger.error({ err: error }, "SSO code exchange failed");
      redirectToError();
      return;
    }

    setAuthCookies(res, {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
    });

    if (provider === "github") {
      await autoConnectGithub(data.session);
    }

    // No separate "signup" step for SSO (unlike email/password, which
    // collects a name + confirms an email first) — the provider's consent
    // screen is that step. Route brand-new accounts through the same
    // onboarding placeholder the email signup flow lands on, and everyone
    // else straight into their projects.
    const { user } = data.session;
    const isNewUser = !!user.created_at && !!user.last_sign_in_at
      && Math.abs(new Date(user.last_sign_in_at).getTime() - new Date(user.created_at).getTime()) < 5000;
    res.redirect(`${env.FRONTEND_ORIGIN}${isNewUser ? "/onboarding" : "/projects"}`);
  } catch (err) {
    logger.error({ err }, "SSO callback failed");
    redirectToError();
  }
}
