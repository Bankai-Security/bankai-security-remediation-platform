import { z } from "zod";

export const generateJenkinsfileProposalSchema = z.object({});

export const acceptJenkinsfileProposalSchema = z.object({
  baseSha: z.string().regex(/^[a-f0-9]{40}$/i, "The reviewed repository revision is invalid."),
  content: z.string().min(1, "Jenkinsfile content is required.").max(100_000, "The Jenkinsfile is too large."),
  summary: z.string().trim().min(1).max(1200),
  assumptions: z.array(z.string().trim().min(1).max(400)).max(8),
});

export type AcceptJenkinsfileProposalInput = z.infer<typeof acceptJenkinsfileProposalSchema>;

export const updateJenkinsfilePullRequestSchema = z.object({
  prNumber: z.number().int().positive(),
  branchName: z.string().regex(/^bankai\/jenkinsfile-[a-f0-9]{12}$/),
  content: z.string().min(1, "Jenkinsfile content is required.").max(100_000, "The Jenkinsfile is too large."),
});

export type UpdateJenkinsfilePullRequestInput = z.infer<typeof updateJenkinsfilePullRequestSchema>;
