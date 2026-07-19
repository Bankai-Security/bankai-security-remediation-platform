import { Router } from "express";
import {
  authorizeGithubAccount,
  disconnectGithubAccount,
  getGithubAccountStatus,
  githubAccountCallback,
  listMyGithubRepos,
} from "../controllers/github-oauth.controller.js";
import { requireAuth } from "../middleware/require-auth.js";

// Mounted at /api/auth/github by auth.routes.ts. Every route requires an
// existing Bankai session — this connects GitHub to an already-logged-in
// user, it is never itself a way to log into Bankai (see the plan's
// "Context" section for why). /callback relies on requireAuth succeeding
// off the SameSite=Lax session cookie surviving GitHub's top-level-navigation
// redirect back to our origin.
export const githubOAuthRouter = Router();

githubOAuthRouter.get("/authorize", requireAuth, authorizeGithubAccount);
githubOAuthRouter.get("/callback", requireAuth, githubAccountCallback);
githubOAuthRouter.get("/status", requireAuth, getGithubAccountStatus);
githubOAuthRouter.post("/disconnect", requireAuth, disconnectGithubAccount);
githubOAuthRouter.get("/repos", requireAuth, listMyGithubRepos);
