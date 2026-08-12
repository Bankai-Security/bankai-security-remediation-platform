import { z } from "zod";

export const createTeamSchema = z.object({
  name: z.string().trim().min(1, "Team name is required").max(120, "Team name is too long"),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z.object({
  name: z.string().trim().min(1, "Team name is required").max(120, "Team name is too long"),
});

export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

// Team membership uses the same admin/editor/viewer vocabulary as orgs/projects
// ('owner' is never a stored membership role).
export const inviteTeamMemberSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase().max(320),
  role: z.enum(["admin", "editor", "viewer"]),
});

export type InviteTeamMemberInput = z.infer<typeof inviteTeamMemberSchema>;

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
});

export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
