import { Router } from "express";
import { cancelQueuedJenkinsRun, claimJenkinsRun, finishJenkinsRun, reportJenkinsProgress } from "../controllers/pipeline.controller.js";

export const pipelineRouter = Router({ mergeParams: true });
pipelineRouter.post("/claim", claimJenkinsRun);
pipelineRouter.post("/runs/:runId/result", finishJenkinsRun);
pipelineRouter.post("/runs/:runId/progress", reportJenkinsProgress);
pipelineRouter.post("/tickets/:ticketId/cancel", cancelQueuedJenkinsRun);
