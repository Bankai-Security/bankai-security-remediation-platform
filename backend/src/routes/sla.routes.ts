import { Router } from "express";
import { updateSlaPolicy } from "../controllers/sla.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { updateSlaPolicySchema } from "../schemas/sla.schema.js";

export const slaRouter = Router({ mergeParams: true });

slaRouter.patch("/", validateBody(updateSlaPolicySchema), updateSlaPolicy);
