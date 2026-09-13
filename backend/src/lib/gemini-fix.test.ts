import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFix, isActionableFixCandidate, type FixFindingInput } from "./gemini-fix.js";

const generateContent = vi.fn();

vi.mock("./gemini.js", () => ({
  getGeminiClient: () => ({
    models: { generateContent },
  }),
}));

const EVAL_FINDING: FixFindingInput = {
  title: "Code Injection via eval()",
  cwe: "CWE-94",
  filePath: "src/legacy/evalRunner.js",
  lineStart: 3,
  lineEnd: 3,
  evidence: "User input is passed directly to eval().",
  remediationGuidance: "Remove eval and validate the expression before executing it.",
};

describe("generateFix", () => {
  beforeEach(() => {
    generateContent.mockReset();
  });

  it("uses Gemini for remediation instead of a deterministic code rewrite", async () => {
    const fixedContent = `export function runExpression(expression) {
  return safeEvaluateExpression(expression);
}
`;
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        confident: true,
        fixedContent,
        summary: "Replaced eval with a safe expression evaluator.",
      }),
    });

    const fix = await generateFix(
      EVAL_FINDING,
      `export function runExpression(expression) {
  return eval(expression);
}
`,
    );

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(fix).toEqual({
      confident: true,
      fixedContent,
      summary: "Replaced eval with a safe expression evaluator.",
    });
  });
});

describe("retry candidate acceptance", () => {
  it("lets deterministic verification judge a changed low-confidence fix", () => {
    expect(isActionableFixCandidate({
      confident: false,
      fixedContent: 'TEST_PASSWORD = "password123"  # nosec B105\n',
      summary: "Annotated the intentional test credential for Bandit.",
    }, 'TEST_PASSWORD = "password123"\n')).toBe(true);
  });

  it("rejects a retry that makes no change", () => {
    expect(isActionableFixCandidate({
      confident: false,
      fixedContent: "unchanged\n",
      summary: "No safe change available.",
    }, "unchanged\n")).toBe(false);
  });
});
