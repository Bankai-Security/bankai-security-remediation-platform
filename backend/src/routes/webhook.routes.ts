import express, { Router } from "express";
import { handleGithubWebhook } from "../controllers/webhook.controller.js";

export const webhookRouter = Router();

// express.raw() here (not the app-wide express.json()) so the exact request
// bytes survive for HMAC signature verification — see app.ts for why this
// router must be mounted before the global json() middleware, and
// webhook.controller.ts for the verification itself. 5mb comfortably fits a
// push payload listing many commits, well past the app-wide 16kb JSON cap
// that's sized for ordinary API requests.
webhookRouter.post("/github/:projectId", express.raw({ type: "application/json", limit: "5mb" }), handleGithubWebhook);
