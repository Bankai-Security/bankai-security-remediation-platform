import { Router } from "express";
import multer from "multer";
import { exchangeRunnerPairingCode } from "../controllers/local-verification.controller.js";
import { claimTask, getTaskControlState, heartbeatTask, reportTaskProgress, submitTaskResult, updateCapabilities, uploadTaskArtifact } from "../controllers/local-runner.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireLocalRunner } from "../middleware/require-local-runner.js";

export const localRunnerPairingRouter = Router();
localRunnerPairingRouter.post("/pair", baselineProtect, exchangeRunnerPairingCode);

export const localRunnerRouter = Router();
const artifactUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2, parts: 3 } });
localRunnerRouter.use(baselineProtect, requireLocalRunner);
localRunnerRouter.post("/tasks/claim", claimTask);
localRunnerRouter.put("/capabilities", updateCapabilities);
localRunnerRouter.get("/tasks/:executionId", getTaskControlState);
localRunnerRouter.post("/tasks/:executionId/heartbeat", heartbeatTask);
localRunnerRouter.post("/tasks/:executionId/progress", reportTaskProgress);
localRunnerRouter.post("/tasks/:executionId/artifacts", artifactUpload.single("artifact"), uploadTaskArtifact);
localRunnerRouter.post("/tasks/:executionId/result", submitTaskResult);
