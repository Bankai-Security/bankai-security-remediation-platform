import { PLACEHOLDER_MARKER } from "./ci-template.js";
import { PIPELINE_STAGE_ORDER } from "./pipeline-types.js";

export function hasPlaceholderChecks(workflow: string): boolean {
  return workflow.split("\n").some((line) => !line.trimStart().startsWith("#") && line.includes(PLACEHOLDER_MARKER));
}

export function assessPipelineVerdict(input: {
  conclusion: string | null;
  workflow: string | null;
  stages: { name: string; conclusion: string | null }[];
}): { status: "passed" | "failed" | "pending_setup"; error: string | null } {
  if (!input.workflow) return { status: "failed", error: "Could not read the workflow used by this run; verification is incomplete." };
  if (hasPlaceholderChecks(input.workflow)) return { status: "pending_setup", error: "Replace the Bankai workflow's placeholder commands with real build, image, deployment, and test checks, then retry CI." };
  const missing = PIPELINE_STAGE_ORDER.filter((name) => !input.stages.some((stage) => stage.name === name));
  if (missing.length) return { status: "failed", error: `Missing verification stages: ${missing.join(", ")}.` };
  if (input.conclusion !== "success" || input.stages.some((stage) => stage.conclusion !== "success")) {
    return { status: "failed", error: "One or more verification stages did not pass." };
  }
  return { status: "passed", error: null };
}
