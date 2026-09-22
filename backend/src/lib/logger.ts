import pino, { type LoggerOptions } from "pino";
import { env } from "../env.js";

const options: LoggerOptions = {
  level: env.NODE_ENV === "production" ? "info" : "debug",
  base: {
    service: process.env.DD_SERVICE ?? "bankai-backend",
    env: process.env.DD_ENV ?? env.NODE_ENV,
    version: process.env.DD_VERSION ?? "unknown",
    "git.sha": process.env.GIT_SHA ?? "unknown",
    "deployment.id": process.env.DEPLOYMENT_ID ?? "unknown",
    "jenkins.build": process.env.JENKINS_BUILD ?? "unknown",
  },
  redact: {
    paths: [
      "req.headers",
      "res.headers",
      "req.headers.cookie",
      "req.headers.authorization",
      "*.password",
      "*.accessToken",
      "*.refreshToken",
      "*.access_token",
      "*.refresh_token",
      "*.apiToken",
      "*.jira_api_token_enc",
    ],
    censor: "[redacted]",
  },
};

if (env.NODE_ENV !== "production") {
  options.transport = { target: "pino-pretty", options: { colorize: true } };
}

export const logger = pino(options);
