import { Router } from "express";
import { acceptJenkinsfileProposal, connectGithub, connectGithubFromAccount, disconnectGithub, getGithubStatus, inspectJenkinsfile, proposeJenkinsfile, scanGithubRepo, updateJenkinsfilePullRequest } from "../controllers/github.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectGithubFromAccountSchema, connectGithubSchema } from "../schemas/github.schema.js";
import { acceptJenkinsfileProposalSchema, generateJenkinsfileProposalSchema, updateJenkinsfilePullRequestSchema } from "../schemas/jenkinsfile.schema.js";

export const githubRouter = Router({ mergeParams: true });

githubRouter.get("/", getGithubStatus);
githubRouter.post("/connect", validateBody(connectGithubSchema), connectGithub);
githubRouter.post("/connect-account", validateBody(connectGithubFromAccountSchema), connectGithubFromAccount);
githubRouter.post("/disconnect", disconnectGithub);
githubRouter.post("/scan", scanGithubRepo);
githubRouter.get("/jenkinsfile", inspectJenkinsfile);
githubRouter.post("/jenkinsfile/proposal", validateBody(generateJenkinsfileProposalSchema), proposeJenkinsfile);
githubRouter.post("/jenkinsfile/pull-request", validateBody(acceptJenkinsfileProposalSchema), acceptJenkinsfileProposal);
githubRouter.post("/jenkinsfile/pull-request/update", validateBody(updateJenkinsfilePullRequestSchema), updateJenkinsfilePullRequest);
