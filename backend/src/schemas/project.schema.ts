import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120, "Project name is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional(),
  // teamIds place the project into one or more teams of the Org → Team
  // hierarchy (all must belong to one org). teamName is the legacy free-text
  // label, kept optional for backward compatibility but no longer set by the UI.
  teamIds: z.array(z.uuid()).max(50, "Too many teams").optional().default([]),
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

// Sets the full list of teams the project belongs to (replace semantics; an
// empty array unassigns it from every team). All teams must be in one org.
export const updateProjectSettingsSchema = z.object({
  teamIds: z.array(z.uuid()).max(50, "Too many teams"),
});

export type UpdateProjectSettingsInput = z.infer<typeof updateProjectSettingsSchema>;
