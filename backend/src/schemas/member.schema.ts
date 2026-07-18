import { z } from "zod";

export const inviteMemberSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase().max(320),
  role: z.enum(["admin", "editor", "viewer"]),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
