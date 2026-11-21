import { z } from "zod";

export const acceptHostedCiProposalSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i, "The default branch commit SHA is invalid."),
  content: z.string().min(1).max(50_000),
});

export type AcceptHostedCiProposalInput = z.infer<typeof acceptHostedCiProposalSchema>;
