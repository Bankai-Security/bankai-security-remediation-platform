import { Router } from "express";
import { cancelQueuedJenkinsRun, claimJenkinsRun, finishJenkinsRun, recordJenkinsAuditAction, reportJenkinsDeployment, reportJenkinsProgress, retryJenkinsVerification } from "../controllers/pipeline.controller.js";

export const pipelineRouter = Router({ mergeParams: true });
pipelineRouter.post("/claim", claimJenkinsRun);
pipelineRouter.post("/audit", recordJenkinsAuditAction);
pipelineRouter.post("/runs/:runId/result", finishJenkinsRun);
pipelineRouter.post("/runs/:runId/progress", reportJenkinsProgress);
pipelineRouter.post("/runs/:runId/deployment", reportJenkinsDeployment);
pipelineRouter.post("/tickets/:ticketId/cancel", cancelQueuedJenkinsRun);
pipelineRouter.post("/tickets/:ticketId/retry", retryJenkinsVerification);
