import { Router } from "express";
import { connectGithub, connectGithubFromAccount, disconnectGithub, getGithubStatus, scanGithubRepo } from "../controllers/github.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectGithubFromAccountSchema, connectGithubSchema } from "../schemas/github.schema.js";

export const githubRouter = Router({ mergeParams: true });

githubRouter.get("/", getGithubStatus);
githubRouter.post("/connect", validateBody(connectGithubSchema), connectGithub);
githubRouter.post("/connect-account", validateBody(connectGithubFromAccountSchema), connectGithubFromAccount);
githubRouter.post("/disconnect", disconnectGithub);
githubRouter.post("/scan", scanGithubRepo);
