import { Router } from "express";
import { authorizeSso, ssoCallback } from "../controllers/sso.controller.js";

// Mounted at /api/auth/sso by auth.routes.ts. "Log in with Google/GitHub" —
// unauthenticated by definition (that's the point), unlike github.routes.ts
// which links a GitHub account to an existing session.
export const ssoRouter = Router();

ssoRouter.get("/callback", ssoCallback);
ssoRouter.get("/:provider", authorizeSso);
