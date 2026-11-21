import { Router } from "express";
import { acceptHostedCiWorkflow, acceptJenkinsfileProposal, connectGithub, connectGithubFromAccount, disconnectGithub, getGithubStatus, inspectJenkinsfile, proposeHostedCiWorkflow, proposeJenkinsfile, scanGithubRepo, updateJenkinsfilePullRequest } from "../controllers/github.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectGithubFromAccountSchema, connectGithubSchema } from "../schemas/github.schema.js";
import { acceptJenkinsfileProposalSchema, generateJenkinsfileProposalSchema, updateJenkinsfilePullRequestSchema } from "../schemas/jenkinsfile.schema.js";
import { acceptHostedCiProposalSchema } from "../schemas/hosted-ci.schema.js";

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
githubRouter.post("/hosted-ci/proposal", proposeHostedCiWorkflow);
githubRouter.post("/hosted-ci/pull-request", validateBody(acceptHostedCiProposalSchema), acceptHostedCiWorkflow);
