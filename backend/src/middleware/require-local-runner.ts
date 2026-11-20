import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function requireLocalRunner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "");
  if (!match) { next(new HttpError(401, "Runner authentication required.")); return; }
  const token = match[1];
  if (!token) { next(new HttpError(401, "Runner authentication required.")); return; }
  const digest = `sha256-${createHash("sha256").update(token).digest("hex")}`;
  const { data, error } = await supabaseAdmin.from("local_runner_installations")
    .select("id, project_id, status, token_digest")
    .eq("token_digest", digest).eq("status", "active").gt("token_expires_at", new Date().toISOString()).maybeSingle();
  if (error || !data || data.token_digest !== digest) { next(new HttpError(401, "Runner credential is invalid or revoked.")); return; }
  res.locals.localRunner = { id: data.id as string, projectId: data.project_id as string };
  next();
}
