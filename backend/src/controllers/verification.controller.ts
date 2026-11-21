import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { HttpError } from "../lib/http-error.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { displayNameFromUser } from "../lib/user-display.js";

type VerificationProvider = "none" | "jenkins" | "hosted_ci";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

export async function getVerificationSettings(req: Request, res: Response): Promise<void> {
  const { data, error } = await userScopedClient(req).from("projects")
    .select("verification_provider,ci_bootstrap_status,ci_bootstrap_pr_url")
    .eq("id", req.project!.id).single();
  if (error || !data) throw new HttpError(500, "Could not load verification settings.");
  res.status(200).json(data);
}

export async function setVerificationProvider(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const provider = req.body?.provider as VerificationProvider;
  const supabase = userScopedClient(req);
  const { data: current } = await supabase.from("projects").select("ci_bootstrap_status,ci_bootstrap_pr_url")
    .eq("id", project.id).single();
  const status = provider === "none" ? null : "pending_setup";
  const message = provider === "none" ? "No CI provider is configured for this project."
    : provider === "hosted_ci" && current?.ci_bootstrap_status !== "ready" ? "Review and merge the hosted CI workflow setup pull request before CI can report a result."
      : provider === "jenkins" ? "Waiting for Jenkins to report the exact pull request commit." : "Hosted CI will report the exact commit when its workflow runs.";
  const { data, error } = await supabase.from("projects").update({ verification_provider: provider }).eq("id", project.id)
    .select("verification_provider,ci_bootstrap_status,ci_bootstrap_pr_url").single();
  if (error || !data) throw new HttpError(500, "Could not save the verification provider.");

  await supabase.from("tickets").update({ ci_status: status, ci_error: message, ...(provider === "none" ? { ci_run_url: null } : {}) })
    .eq("project_id", project.id).eq("github_pr_state", "open");
  await recordActivity(supabase, { projectId: project.id, actorId: req.user!.id, actorLabel: displayNameFromUser(req.user!),
    eventType: "pipeline", summary: provider === "none" ? "disabled CI verification for" : `selected ${provider === "jenkins" ? "Jenkins" : "hosted CI"} verification for`, linkLabel: project.name, linkTo: "settings" });
  res.status(200).json(data);
}
