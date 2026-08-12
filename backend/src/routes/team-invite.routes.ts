import { Router } from "express";
import { acceptTeamInvite, declineTeamInvite, getTeamInviteByToken, listMyTeamInvites } from "../controllers/team-invite.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireAuth } from "../middleware/require-auth.js";

// Not nested under /orgs/:orgId/teams — the invitee isn't a team member yet, so
// there's nothing for loadOrg/loadTeam to resolve. Mirrors orgInviteRouter.
export const teamInviteRouter = Router();

teamInviteRouter.use(requireAuth, baselineProtect);

teamInviteRouter.get("/", listMyTeamInvites);
teamInviteRouter.get("/:token", getTeamInviteByToken);
teamInviteRouter.post("/:token/accept", acceptTeamInvite);
teamInviteRouter.post("/:token/decline", declineTeamInvite);
