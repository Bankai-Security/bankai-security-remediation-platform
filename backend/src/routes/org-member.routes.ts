import { Router } from "express";
import { inviteOrgMember, listOrgMembers, removeOrgMember, revokeOrgInvite, updateOrgMemberRole } from "../controllers/org-member.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { inviteOrgMemberSchema, updateOrgMemberRoleSchema } from "../schemas/org.schema.js";

export const orgMemberRouter = Router({ mergeParams: true });

orgMemberRouter.get("/", listOrgMembers);
orgMemberRouter.post("/invite", validateBody(inviteOrgMemberSchema), inviteOrgMember);
orgMemberRouter.patch("/:memberId", validateBody(updateOrgMemberRoleSchema), updateOrgMemberRole);
orgMemberRouter.delete("/:memberId", removeOrgMember);
orgMemberRouter.delete("/invites/:inviteId", revokeOrgInvite);
