import { Router } from "express";
import { acceptInvite, declineInvite, getInviteByToken, listMyInvites } from "../controllers/invite.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireAuth } from "../middleware/require-auth.js";

// Not nested under /projects/:projectId — the invitee isn't a project
// member yet, so there's nothing for loadProject to resolve.
export const inviteRouter = Router();

inviteRouter.use(requireAuth, baselineProtect);

inviteRouter.get("/", listMyInvites);
inviteRouter.get("/:token", getInviteByToken);
inviteRouter.post("/:token/accept", acceptInvite);
inviteRouter.post("/:token/decline", declineInvite);
