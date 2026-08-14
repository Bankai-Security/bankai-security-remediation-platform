import { Router } from "express";
import { createOrg, deleteOrg, getOrg, listOrgActivity, listOrgs, updateOrg } from "../controllers/org.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { loadOrg } from "../middleware/load-org.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate-body.js";
import { transferOrgOwnership } from "../controllers/org-member.controller.js";
import { createOrgSchema, transferOrgSchema, updateOrgSchema } from "../schemas/org.schema.js";
import { orgMemberRouter } from "./org-member.routes.js";
import { teamRouter } from "./team.routes.js";

export const orgRouter = Router();

orgRouter.use(requireAuth, baselineProtect);

orgRouter.get("/", listOrgs);
orgRouter.post("/", validateBody(createOrgSchema), createOrg);
orgRouter.get("/:id", getOrg);

// Everything under /:orgId/* (members, teams) is scoped to a single org —
// loadOrg resolves it once and 404s here if the caller isn't a member, before
// any nested route runs. Mirrors the projectScoped sub-router.
const orgScoped = Router({ mergeParams: true });
orgScoped.use(loadOrg);
orgScoped.patch("/", validateBody(updateOrgSchema), updateOrg);
orgScoped.delete("/", deleteOrg);
orgScoped.get("/activity", listOrgActivity);
orgScoped.post("/transfer", validateBody(transferOrgSchema), transferOrgOwnership);
orgScoped.use("/members", orgMemberRouter);
orgScoped.use("/teams", teamRouter);

orgRouter.use("/:orgId", orgScoped);
