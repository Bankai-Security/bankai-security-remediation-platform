import { z } from "zod";

// Accepts a bare "owner/repo" or a full GitHub URL and normalizes to "owner/repo".
function normalizeRepo(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return trimmed;
}

const repoField = z
  .string()
  .trim()
  .min(1, "Repository is required")
  .transform(normalizeRepo)
  .refine((value) => /^[\w.-]+\/[\w.-]+$/.test(value), "Enter a repository as owner/repo or a GitHub URL");

export const connectGithubSchema = z.object({
  repo: repoField,
  token: z.string().trim().min(10, "Token looks too short").max(1024, "Token is too long"),
  baseBranch: z.string().trim().max(255, "Base branch name is too long").optional(),
});

export type ConnectGithubInput = z.infer<typeof connectGithubSchema>;

// Repo picker flow (Settings' "GitHub Account" connection) — no token in
// the request, the project pulls the caller's stored account-level token.
export const connectGithubFromAccountSchema = z.object({
  repo: repoField,
  baseBranch: z.string().trim().max(255, "Base branch name is too long").optional(),
});

export type ConnectGithubFromAccountInput = z.infer<typeof connectGithubFromAccountSchema>;
