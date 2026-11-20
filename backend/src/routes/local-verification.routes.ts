import { Router } from "express";
import { cancelLocalVerificationTask, chooseLocalVerification, createRunnerPairingCode, downloadLocalVerificationArtifact, listLocalVerificationTasks, revokeLocalRunner } from "../controllers/local-verification.controller.js";

export const localVerificationRouter = Router({ mergeParams: true });
localVerificationRouter.get("/", listLocalVerificationTasks);
localVerificationRouter.post("/remediations/:remediationId/choice", chooseLocalVerification);
localVerificationRouter.post("/pairing-codes", createRunnerPairingCode);
localVerificationRouter.post("/runners/:runnerId/revoke", revokeLocalRunner);
localVerificationRouter.get("/:taskId/artifacts/:name", downloadLocalVerificationArtifact);
localVerificationRouter.post("/:taskId/cancel", cancelLocalVerificationTask);
