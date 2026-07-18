import { z } from "zod";

export const connectJiraSchema = z.object({
  site: z.string().trim().min(1, "Site is required").max(253, "Site is too long"),
  email: z.email("Enter a valid email address").trim().max(320, "Email is too long"),
  apiToken: z.string().trim().min(10, "API token looks too short").max(1024, "API token is too long"),
  projectKey: z
    .string()
    .trim()
    .min(1, "Project key is required")
    .max(20, "Project key is too long")
    .regex(/^[A-Z][A-Z0-9]+$/, "Project key must be uppercase letters/numbers, e.g. BNK"),
});

export type ConnectJiraInput = z.infer<typeof connectJiraSchema>;
