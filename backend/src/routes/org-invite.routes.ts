import { Router } from "express";
import { acceptOrgInvite, declineOrgInvite, getOrgInviteByToken, listMyOrgInvites } from "../controllers/org-invite.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireAuth } from "../middleware/require-auth.js";

// Not nested under /orgs/:orgId — the invitee isn't an org member yet, so
// there's nothing for loadOrg to resolve. Mirrors the project inviteRouter.
export const orgInviteRouter = Router();

orgInviteRouter.use(requireAuth, baselineProtect);

orgInviteRouter.get("/", listMyOrgInvites);
orgInviteRouter.get("/:token", getOrgInviteByToken);
orgInviteRouter.post("/:token/accept", acceptOrgInvite);
orgInviteRouter.post("/:token/decline", declineOrgInvite);
