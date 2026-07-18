import { Router } from "express";
import { connectJira, disconnectJira, getJiraStatus } from "../controllers/jira.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectJiraSchema } from "../schemas/jira.schema.js";

export const jiraRouter = Router({ mergeParams: true });

jiraRouter.get("/", getJiraStatus);
jiraRouter.post("/connect", validateBody(connectJiraSchema), connectJira);
jiraRouter.post("/disconnect", disconnectJira);
