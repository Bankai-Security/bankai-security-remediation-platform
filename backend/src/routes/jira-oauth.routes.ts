import { Router } from "express";
import { jiraOAuthCallback } from "../controllers/jira.controller.js";

export const jiraOAuthRouter = Router();
jiraOAuthRouter.get("/callback", jiraOAuthCallback);
