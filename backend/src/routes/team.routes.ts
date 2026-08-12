import { Router } from "express";
import { createTeam, deleteTeam, listTeams, updateTeam } from "../controllers/team.controller.js";
import { loadTeam } from "../middleware/load-team.js";
import { validateBody } from "../middleware/validate-body.js";
import { createTeamSchema, updateTeamSchema } from "../schemas/team.schema.js";
import { teamMemberRouter } from "./team-member.routes.js";

// Mounted at /api/orgs/:orgId/teams under the org-scoped router (loadOrg has
// already run, so req.org is set). mergeParams so :orgId is visible here.
export const teamRouter = Router({ mergeParams: true });

teamRouter.get("/", listTeams);
teamRouter.post("/", validateBody(createTeamSchema), createTeam);

// Everything under /:teamId/* is scoped to a single team — loadTeam resolves it
// once and 404s if the caller can't see it, before any nested route runs.
const teamScoped = Router({ mergeParams: true });
teamScoped.use(loadTeam);
teamScoped.patch("/", validateBody(updateTeamSchema), updateTeam);
teamScoped.delete("/", deleteTeam);
teamScoped.use("/members", teamMemberRouter);

teamRouter.use("/:teamId", teamScoped);
