import pino, { type LoggerOptions } from "pino";
import { env } from "../env.js";

const options: LoggerOptions = {
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
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
