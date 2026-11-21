import { Router } from "express";
import { getVerificationSettings, setVerificationProvider } from "../controllers/verification.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { verificationProviderSchema } from "../schemas/verification.schema.js";

export const verificationRouter = Router({ mergeParams: true });
verificationRouter.get("/", getVerificationSettings);
verificationRouter.put("/", validateBody(verificationProviderSchema), setVerificationProvider);
