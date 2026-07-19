import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ARCJET_KEY: z.string().min(1),

  // Base64 of 32 random bytes — encrypts secrets at rest (Jira API tokens,
  // GitHub PATs, GitHub webhook secrets).
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  TOKEN_ENC_KEY: z.string().min(1),

  FRONTEND_ORIGIN: z.url(),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),

  // Powers AI repo scanning (backend/src/lib/gemini.ts). Get a key from
  // https://aistudio.google.com/apikey.
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default("gemini-pro-latest"),

  // Backs the repo-scan job queue (backend/src/lib/queue.ts) — required by
  // both the API server (to enqueue) and the worker (backend/src/worker.ts,
  // to process). Defaults to a local Redis for dev.
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // Publicly reachable base URL for this backend, e.g. "https://api.bankai.app"
  // — used only to auto-register GitHub push webhooks
  // (POST /repos/{repo}/hooks) at connect time. A local dev backend has no
  // such URL, so this is optional: leaving it unset just means GitHub
  // repos connected here fall back to "set up the webhook manually"
  // instead of getting push-triggered rescans automatically.
  BACKEND_PUBLIC_URL: z.url().optional(),

  // File-filtering caps for a repo scan (backend/src/lib/github.ts) — keep
  // Gemini call volume and latency bounded on large repos.
  MAX_SCAN_FILES: z.coerce.number().int().positive().default(400),
  MAX_SCAN_FILE_BYTES: z.coerce.number().int().positive().default(200_000),
  MAX_SCAN_TOTAL_BYTES: z.coerce.number().int().positive().default(20_000_000),

  // Powers "Connect your GitHub account" (backend/src/lib/github-oauth.ts) —
  // a per-user OAuth grant covering all the user's repos, as an alternative
  // to pasting a PAT per project. Register a GitHub OAuth App at
  // https://github.com/settings/developers with callback URL
  // {BACKEND_PUBLIC_URL or http://localhost:PORT}/api/auth/github/callback.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
