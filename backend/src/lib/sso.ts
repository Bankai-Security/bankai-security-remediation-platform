import { env } from "../env.js";

export const SSO_PROVIDERS = ["google", "github"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export function isSsoProvider(value: string): value is SsoProvider {
  return (SSO_PROVIDERS as readonly string[]).includes(value);
}

// Requested only for provider === "github", added on top of (not replacing)
// Supabase's own default GitHub scope — confirmed via the actual authorize
// URL that Supabase's dashboard-configured provider already requests
// user:email on its own, so specifying it again here would just duplicate
// it in GitHub's consent screen. This makes the same login grant double as
// the "Connect GitHub account" repo-scanning grant (see sso.controller.ts's
// post-exchange profiles update).
export const GITHUB_SSO_SCOPES = "repo";

// "Log in with Google/GitHub", handled entirely by Supabase's own OAuth
// integration (Authentication -> Providers in the Supabase dashboard).
// Deliberately separate from lib/github-oauth.ts, which links a GitHub
// account to an *already logged-in* Bankai session for repo scanning via
// its own hand-rolled OAuth App (GITHUB_OAUTH_CLIENT_ID) — that flow is
// never a way to log into Bankai, and this one is never a way to grant
// repo-scanning access.
export function ssoCallbackUrl(): string {
  const base = env.BACKEND_PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  return `${base}/api/auth/sso/callback`;
}
