import { generateOpenRouterJson } from "./openrouter.js";
import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { env } from "../env.js";
import { getGeminiClient } from "./gemini.js";
import { logger } from "./logger.js";

export interface FixFindingInput {
  title: string;
  cwe: string | null;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  evidence: string;
  remediationGuidance: string;
}

const GeminiFileUpdateSchema = z.object({
  filePath: z.string(),
  fixedContent: z.string(),
});

const GeminiFixResultSchema = z.object({
  confident: z.boolean(),
  fixedContent: z.string(),
  summary: z.string().min(1),
  filesToUpdate: z.array(GeminiFileUpdateSchema).optional(),
});

export type GeneratedFix = z.infer<typeof GeminiFixResultSchema>;

// Confidence is advisory metadata, not a validation verdict. A changed retry
// patch still has to pass Bankai's scanner, CI-parity, and repository tests, so
// discarding it here prevents those deterministic gates from doing their job.
export function isActionableFixCandidate(fix: GeneratedFix, currentContent: string): boolean {
  return fix.fixedContent !== currentContent;
}

export interface FixRetryContext {
  attempt: number; // this attempt's number (2 or 3 — 1 is the original, non-retry call)
  maxAttempts: number;
  failedStage: string;
  failureLog: string | null;
}

// Mirrors GeminiFixResultSchema above
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    confident: {
      type: Type.BOOLEAN,
      description:
        "true only if fixedContent is a correct, complete fix for the described vulnerability that changes nothing else. false if fixedContent is a best-effort fix you are not highly sure about — a human will review it with extra care before merging.",
    },
    fixedContent: {
      type: Type.STRING,
      description: "The entire corrected main file content, verbatim, ready to be committed as-is (not a diff/patch).",
    },
    summary: {
      type: Type.STRING,
      description: "1-3 sentences describing what was changed and why, suitable for a commit message and PR description.",
    },
    filesToUpdate: {
      type: Type.ARRAY,
      description:
        "Optional array of additional files to update alongside the main file (e.g. schemas, imports, or test fixtures) if the fix requires multi-file updates.",
      items: {
        type: Type.OBJECT,
        properties: {
          filePath: { type: Type.STRING, description: "Relative file path in the repository." },
          fixedContent: { type: Type.STRING, description: "Entire corrected file content, verbatim." },
        },
        required: ["filePath", "fixedContent"],
      },
    },
  },
  required: ["confident", "fixedContent", "summary"],
};

const SYSTEM_PROMPT = `You are a senior application security engineer producing a surgical code fix for an identified vulnerability.

Change only what is necessary to remediate the specific issue described — preserve all unrelated code, formatting, comments, and style. Ensure your fix complies with existing interfaces, test suites, and repository contracts provided in context.

Return the ENTIRE corrected target file content in fixedContent (not a diff/patch), so it can be committed verbatim.
If the fix requires complementary updates to related files (e.g. schema definitions or test helpers), include them in filesToUpdate.

Always return your best-effort fix in fixedContent. If you are not highly confident the fix is both correct and complete, still return it — but set confident:false so a human reviewer knows to scrutinize it before merging, and use summary to state what you are unsure about. Only return fixedContent identical to the original file content when you cannot propose any meaningful remediation at all.

Respond with JSON matching the provided schema.`;

const RETRY_SYSTEM_PROMPT_ADDENDUM = `

This is a retry: a previous attempt of yours already fixed this vulnerability and was committed, but automated CI verification failed. The file content given to you below is that previous attempt's code, not the original vulnerable file, and a CI failure log is included showing what went wrong.

For dependency fixes, check the supplied Dockerfile and CI runtime versions against registry requires_python constraints. Keep patched dependency versions compatible with the runtime, or update the runtime consistently in Docker and CI through filesToUpdate. Never reintroduce the CVE to fix installation. Preserve every existing verification step.

Before changing anything, decide which of these two cases applies:
1. Your previous fix has a genuine bug or is incomplete — the failure is something you can and should fix. Produce a revised fixedContent (and filesToUpdate if relevant).
2. The failing test is itself asserting or requiring the vulnerable behavior — your fix is correct and the test itself is the obstacle. No revised code can make both the test and the security fix pass.

If case 2 applies, set confident:false and use summary to explain, in plain language, why the failing test requires the vulnerable behavior to remain.`;

function buildUserPrompt(
  finding: FixFindingInput,
  fileContent: string,
  retryContext?: FixRetryContext,
  repoContextPrompt?: string,
): string {
  const numbered = fileContent
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");

  const location =
    finding.lineStart != null
      ? `Lines ${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}`
      : "No specific line range";

  const contextHeader = repoContextPrompt ? `${repoContextPrompt}\n\n` : "";

  return `${contextHeader}Vulnerability: ${finding.title}
CWE: ${finding.cwe ?? "N/A"}
File: ${finding.filePath}
${location}

Evidence:
${finding.evidence}

Remediation guidance:
${finding.remediationGuidance}

=== TARGET FILE: ${finding.filePath} ===
${numbered}${
    retryContext
      ? `\n\n=== CI FAILURE (attempt ${retryContext.attempt} of ${retryContext.maxAttempts}, stage: ${retryContext.failedStage}) ===\n${retryContext.failureLog ?? "(log unavailable — no further detail than the stage name)"}`
      : ""
  }`;
}

// Best-effort, same contract as gemini.ts's analyzeChunk: 2 attempts, never
// throws — a fix-generation failure degrades to "no PR", never blocks upstream.
export async function generateFix(
  finding: FixFindingInput,
  fileContent: string,
  retryContext?: FixRetryContext,
  repoContextPrompt?: string,
): Promise<GeneratedFix | null> {
  if (fileContent.length > env.MAX_SCAN_FILE_BYTES) {
    logger.warn(
      { filePath: finding.filePath, size: fileContent.length },
      "Skipping AI fix generation — file exceeds MAX_SCAN_FILE_BYTES",
    );
    return null;
  }

  const contents = buildUserPrompt(finding, fileContent, retryContext, repoContextPrompt);
  const systemInstruction = retryContext ? SYSTEM_PROMPT + RETRY_SYSTEM_PROMPT_ADDENDUM : SYSTEM_PROMPT;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string | undefined;
    try {
      const response = env.AI_PROVIDER === "openrouter" ? { text: await generateOpenRouterJson(systemInstruction, contents, GeminiFixResultSchema, attempt) } : await getGeminiClient().models.generateContent({
        model: env.GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      });
      text = response.text;
    } catch (err) {
      logger.error({ err, attempt, filePath: finding.filePath }, "AI fix-generation request failed");
      continue;
    }

    if (!text) {
      logger.error({ attempt, filePath: finding.filePath }, "AI returned an empty fix-generation response");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error({ err, attempt, filePath: finding.filePath }, "AI fix-generation response was not valid JSON");
      continue;
    }

    const result = GeminiFixResultSchema.safeParse(parsed);
    if (!result.success) {
      logger.error(
        { issues: result.error.issues, attempt, filePath: finding.filePath },
        "AI fix-generation response did not match the expected schema",
      );
      continue;
    }

    return result.data;
  }

  logger.error({ filePath: finding.filePath }, "Dropping fix generation after repeated AI failures");
  return null;
}
