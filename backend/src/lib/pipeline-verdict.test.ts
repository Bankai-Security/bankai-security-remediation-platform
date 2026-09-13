import { describe, expect, it } from "vitest";
import { assessPipelineVerdict } from "./pipeline-verdict.js";
import { PIPELINE_STAGE_ORDER } from "./pipeline-types.js";

const stages = PIPELINE_STAGE_ORDER.map((name) => ({ name, conclusion: "success" }));
describe("pipeline evidence", () => {
  it("does not certify a successful placeholder workflow", () => {
    expect(assessPipelineVerdict({ conclusion: "success", workflow: `run: echo "TODO - add this repo's FT test commands here"`, stages }).status).toBe("pending_setup");
  });
  it("requires evidence from every stage", () => {
    expect(assessPipelineVerdict({ conclusion: "success", workflow: "run: pytest", stages: stages.slice(0, 2) }).status).toBe("failed");
    expect(assessPipelineVerdict({ conclusion: "success", workflow: null, stages }).status).toBe("failed");
  });
  it("rejects skipped tests and accepts a fully verified run", () => {
    expect(assessPipelineVerdict({ conclusion: "success", workflow: "run: pytest", stages: [...stages.slice(0, 4), { name: "integration-test", conclusion: "skipped" }] }).status).toBe("failed");
    expect(assessPipelineVerdict({ conclusion: "success", workflow: "run: pytest", stages })).toEqual({ status: "passed", error: null });
  });
});
