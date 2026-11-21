import { z } from "zod";

const optionalNonEmptyString = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // Label the Supabase project these credentials belong to. This is a
  // fail-fast guard against pointing local development at production data.
  SUPABASE_ENV: z.enum(["development", "production"]).default("development"),
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

  // AI settings for source analysis and Bankai remediation patch generation.
  AI_PROVIDER: z.enum(["openrouter", "gemini"]).default("openrouter"),
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENROUTER_REASONING_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  OPENROUTER_MODEL_NAME: z.string().min(1).default("deepseek/deepseek-v4-flash-0731"),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GEMINI_API_KEY: optionalNonEmptyString,
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

  // Keep per-file fix-generation context bounded.
  MAX_SCAN_FILE_BYTES: z.coerce.number().int().positive().default(200_000),

  // Context-assembly budgets for AI fix generation (backend/src/lib/repo-context.ts)
  MAX_FIX_CONTEXT_FILES: z.coerce.number().int().positive().default(10),
  MAX_FIX_CONTEXT_BYTES: z.coerce.number().int().positive().default(200_000),
  MAX_FIX_TEST_FILES: z.coerce.number().int().positive().default(5),
  MAX_FIX_TREE_DEPTH: z.coerce.number().int().positive().default(3),

  // Powers "Connect your GitHub account" (backend/src/lib/github-oauth.ts) —
  // a per-user OAuth grant covering all the user's repos, as an alternative
  // to pasting a PAT per project. Register a GitHub OAuth App at
  // https://github.com/settings/developers with callback URL
  // {BACKEND_PUBLIC_URL or http://localhost:PORT}/api/auth/github/callback.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
  ATLASSIAN_OAUTH_CLIENT_ID: optionalNonEmptyString,
  ATLASSIAN_OAUTH_CLIENT_SECRET: optionalNonEmptyString,
  ATLASSIAN_OAUTH_REDIRECT_URI: z.url().optional(),
}).superRefine((env, ctx) => {
  const key = env.AI_PROVIDER === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
  if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `required for AI_PROVIDER=${env.AI_PROVIDER}` });
  if (env.NODE_ENV === "production" && env.APP_ENV !== "production") {
    ctx.addIssue({
      code: "custom",
      path: ["APP_ENV"],
      message: "must be production when NODE_ENV is production",
    });
  }

  if (env.APP_ENV !== env.SUPABASE_ENV) {
    ctx.addIssue({
      code: "custom",
      path: ["SUPABASE_ENV"],
      message: `must match APP_ENV (${env.APP_ENV})`,
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const parsedEnv = parsed.data;

export const env = parsedEnv;
