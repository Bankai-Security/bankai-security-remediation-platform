import { z } from "zod";

export const createOrgSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(120, "Organization name is too long"),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(120, "Organization name is too long"),
});

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

// Same shape as the project member schemas — org membership uses the identical
// admin/editor/viewer vocabulary ('owner' is derived from owner_id, never
// stored as a membership role).
export const inviteOrgMemberSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase().max(320),
  role: z.enum(["admin", "editor", "viewer"]),
});

export type InviteOrgMemberInput = z.infer<typeof inviteOrgMemberSchema>;

export const updateOrgMemberRoleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
});

// Hands org ownership to an existing member (by their profile id).
export const transferOrgSchema = z.object({
  userId: z.uuid(),
});

export type TransferOrgInput = z.infer<typeof transferOrgSchema>;

export type UpdateOrgMemberRoleInput = z.infer<typeof updateOrgMemberRoleSchema>;
