import { Router } from "express";
import { disconnectJiraAccountOAuth, getJiraAccountOAuthStatus, startJiraAccountOAuth } from "../controllers/jira-account-oauth.controller.js";
import { requireAuth } from "../middleware/require-auth.js";

export const jiraAccountOAuthRouter = Router();
jiraAccountOAuthRouter.get("/status", requireAuth, getJiraAccountOAuthStatus);
jiraAccountOAuthRouter.get("/authorize", requireAuth, startJiraAccountOAuth);
jiraAccountOAuthRouter.post("/disconnect", requireAuth, disconnectJiraAccountOAuth);
