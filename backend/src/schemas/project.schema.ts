import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120, "Project name is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional(),
  teamName: z.string().trim().max(120, "Team name is too long").optional(),
  services: z
    .array(z.string().trim().min(1).max(80))
    .max(50, "Too many services")
    .optional()
    .default([]),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const deleteProjectSchema = z.object({
  confirmName: z.string().trim().min(1, "Type the project name to confirm"),
});

export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>;

export const updateProjectSettingsSchema = z.object({
  teamName: z.string().trim().max(120, "Team name is too long").optional(),
});

export type UpdateProjectSettingsInput = z.infer<typeof updateProjectSettingsSchema>;
