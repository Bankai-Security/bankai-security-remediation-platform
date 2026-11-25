import { Router } from "express";
import { disconnectJiraAccountOAuth, getJiraAccountOAuthStatus, listJiraAccountOAuthProjects, listJiraAccountOAuthSites, startJiraAccountOAuth } from "../controllers/jira-account-oauth.controller.js";
import { requireAuth } from "../middleware/require-auth.js";

export const jiraAccountOAuthRouter = Router();
jiraAccountOAuthRouter.get("/status", requireAuth, getJiraAccountOAuthStatus);
jiraAccountOAuthRouter.get("/authorize", requireAuth, startJiraAccountOAuth);
jiraAccountOAuthRouter.get("/sites", requireAuth, listJiraAccountOAuthSites);
jiraAccountOAuthRouter.get("/projects", requireAuth, listJiraAccountOAuthProjects);
jiraAccountOAuthRouter.post("/disconnect", requireAuth, disconnectJiraAccountOAuth);
