import { Router } from "express";
import { inviteMember, listMembers, removeMember, revokeInvite, updateMemberRole } from "../controllers/member.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { inviteMemberSchema, updateMemberRoleSchema } from "../schemas/member.schema.js";

export const memberRouter = Router({ mergeParams: true });

memberRouter.get("/", listMembers);
memberRouter.post("/invite", validateBody(inviteMemberSchema), inviteMember);
memberRouter.patch("/:memberId", validateBody(updateMemberRoleSchema), updateMemberRole);
memberRouter.delete("/:memberId", removeMember);
memberRouter.delete("/invites/:inviteId", revokeInvite);
