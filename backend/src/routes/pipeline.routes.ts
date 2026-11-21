import { Router } from "express";
import { cancelQueuedJenkinsRun, claimJenkinsRun, finishJenkinsRun, reportJenkinsDeployment, reportJenkinsProgress } from "../controllers/pipeline.controller.js";

export const pipelineRouter = Router({ mergeParams: true });
pipelineRouter.post("/claim", claimJenkinsRun);
pipelineRouter.post("/runs/:runId/result", finishJenkinsRun);
pipelineRouter.post("/runs/:runId/progress", reportJenkinsProgress);
pipelineRouter.post("/runs/:runId/deployment", reportJenkinsDeployment);
pipelineRouter.post("/tickets/:ticketId/cancel", cancelQueuedJenkinsRun);
