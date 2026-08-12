import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120, "Project name is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional(),
  // teamId places the project directly into the Org → Team hierarchy. teamName
  // is the legacy free-text label, kept optional for backward compatibility but
  // no longer set by the UI.
  teamId: z.uuid().optional(),
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

// Assigns the project to a team in the hierarchy (or null to unassign). This
// replaces the old free-text team_name control — the project's team is now a
// real teams row, so the org rollup groups it correctly.
export const updateProjectSettingsSchema = z.object({
  teamId: z.uuid().nullable(),
});

export type UpdateProjectSettingsInput = z.infer<typeof updateProjectSettingsSchema>;
