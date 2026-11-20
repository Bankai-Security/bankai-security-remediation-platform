import { supabaseAdmin } from "./supabase.js";

/** Expire abandoned leases and fail the matching current remediation attempt closed. */
export async function reconcileExpiredLocalRunnerLeases(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("expire_local_runner_leases");
  if (error) throw new Error(`Local runner lease recovery failed: ${error.message}`);
  if (typeof data !== "number" || !Number.isInteger(data) || data < 0) {
    throw new Error("Local runner lease recovery returned an invalid count.");
  }
  return data;
}
