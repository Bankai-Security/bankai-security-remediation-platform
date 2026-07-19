import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { originCheck } from "./middleware/origin-check.js";
import { authRouter } from "./routes/auth.routes.js";
import { inviteRouter } from "./routes/invite.routes.js";
import { projectRouter } from "./routes/project.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    }),
  );
  // Mounted before the app-wide express.json() below, with its own
  // express.raw() internally — GitHub's HMAC signature is computed over the
  // exact request bytes, which express.json() would otherwise have already
  // parsed and discarded by the time a webhook route saw them. Everything
  // else (auth, project routes) is unaffected: this only intercepts
  // /api/webhooks/*.
  app.use("/api/webhooks", webhookRouter);

  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      redact: ["req.headers.cookie", "req.headers.authorization"],
      autoLogging: env.NODE_ENV === "production",
    }),
  );
  app.use(originCheck);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectRouter);
  app.use("/api/invites", inviteRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}
