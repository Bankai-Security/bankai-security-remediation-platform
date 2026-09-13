import { z } from "zod";
import { env } from "../env.js";

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).min(1),
});

// Keep the timeout active while consuming the body, and never include provider
// response bodies in errors: they can contain repository source or credentials.
export async function generateOpenRouterJson(system: string, contents: string, schema: z.ZodType, attempt = 1): Promise<string> {
  const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_NAME,
      messages: [{ role: "system", content: system }, { role: "user", content: contents }],
      temperature: 0,
      max_tokens: attempt > 1 ? 16384 : 8096,
      provider: { require_parameters: true },
      reasoning: { enabled: env.OPENROUTER_REASONING_ENABLED },
      response_format: { type: "json_schema", json_schema: { name: "bankai_response", strict: true, schema: z.toJSONSchema(schema) } },
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
  const parsed = completionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("OpenRouter returned an invalid completion");
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason !== "stop" || choice.message.refusal || !choice.message.content?.trim()) {
    throw new Error("OpenRouter returned an incomplete, refused, or empty completion");
  }
  return choice.message.content;
}
