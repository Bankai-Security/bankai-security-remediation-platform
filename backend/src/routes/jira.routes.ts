import { Router } from "express";
import { connectJira, disconnectJira, getJiraStatus, listJiraOAuthProjects, listJiraOAuthSites, selectJiraOAuthProject, startJiraOAuth } from "../controllers/jira.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectJiraSchema, selectJiraOAuthProjectSchema } from "../schemas/jira.schema.js";

export const jiraRouter = Router({ mergeParams: true });

jiraRouter.get("/", getJiraStatus);
jiraRouter.post("/oauth/start", startJiraOAuth);
jiraRouter.get("/oauth/sites", listJiraOAuthSites);
jiraRouter.get("/oauth/projects", listJiraOAuthProjects);
jiraRouter.post("/oauth/select", validateBody(selectJiraOAuthProjectSchema), selectJiraOAuthProject);
jiraRouter.post("/connect", validateBody(connectJiraSchema), connectJira);
jiraRouter.post("/disconnect", disconnectJira);
