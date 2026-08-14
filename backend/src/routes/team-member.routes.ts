import { Router } from "express";
import { inviteTeamMember, listTeamMembers, removeTeamMember, resendTeamInvite, revokeTeamInvite, updateTeamMemberRole } from "../controllers/team-member.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { inviteTeamMemberSchema, updateTeamMemberRoleSchema } from "../schemas/team.schema.js";

export const teamMemberRouter = Router({ mergeParams: true });

teamMemberRouter.get("/", listTeamMembers);
teamMemberRouter.post("/invite", validateBody(inviteTeamMemberSchema), inviteTeamMember);
teamMemberRouter.patch("/:memberId", validateBody(updateTeamMemberRoleSchema), updateTeamMemberRole);
teamMemberRouter.delete("/:memberId", removeTeamMember);
teamMemberRouter.delete("/invites/:inviteId", revokeTeamInvite);
teamMemberRouter.post("/invites/:inviteId/resend", resendTeamInvite);
