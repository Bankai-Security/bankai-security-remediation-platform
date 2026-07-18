import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireRole } from "../lib/roles.js";
import type { SlaPolicyDays } from "../lib/sla.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { UpdateSlaPolicyInput } from "../schemas/sla.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

function toPublicSlaPolicy(policyDays: SlaPolicyDays) {
  return { critical: policyDays.Critical, high: policyDays.High, medium: policyDays.Medium, low: policyDays.Low };
}

export async function updateSlaPolicy(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin"]);
  const { critical, high, medium, low } = req.body as UpdateSlaPolicyInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("projects")
    .update({
      sla_critical_days: critical,
      sla_high_days: high,
      sla_medium_days: medium,
      sla_low_days: low,
    })
    .eq("id", req.project!.id)
    .select("sla_critical_days, sla_high_days, sla_medium_days, sla_low_days")
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not save the SLA policy.");
  }

  res.status(200).json(
    toPublicSlaPolicy({
      Critical: data.sla_critical_days,
      High: data.sla_high_days,
      Medium: data.sla_medium_days,
      Low: data.sla_low_days,
    }),
  );
}
