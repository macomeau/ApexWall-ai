import OpenAI from "openai";

const gatewayToken = process.env.NEON_AI_GATEWAY_TOKEN || "";
const gatewayBaseUrl = (process.env.NEON_AI_GATEWAY_BASE_URL || "").replace(/\/$/, "");

/**
 * Model fallback chain. Override with AI_MODELS="model-a,model-b,model-c".
 * Check the branch's catalog at GET {NEON_AI_GATEWAY_BASE_URL}/v1/models
 * for the exact IDs available to this account.
 */
const DEFAULT_MODELS = ["gpt-5-mini", "claude-haiku-4-5", "gemini-3-flash"];
const MODELS: string[] = (process.env.AI_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (MODELS.length === 0) MODELS.push(...DEFAULT_MODELS);

const CHAT_MODELS: string[] = (process.env.AI_CHAT_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (CHAT_MODELS.length === 0) CHAT_MODELS.push(...DEFAULT_MODELS);

function getClient(): OpenAI {
  if (!gatewayToken || !gatewayBaseUrl) {
    throw new Error(
      "NEON_AI_GATEWAY_TOKEN / NEON_AI_GATEWAY_BASE_URL are not configured in environment variables."
    );
  }
  return new OpenAI({
    apiKey: gatewayToken,
    baseURL: `${gatewayBaseUrl}/v1`,
  });
}

function extractJSON(text: string): any {
  // Strip markdown fences if present
  let clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Try direct parse
  try {
    return JSON.parse(clean);
  } catch {
    // Locate the first { and the last }
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = clean.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate);
    }
    throw new Error("Could not find valid JSON object in model response.");
  }
}

export async function callAIWithFallback(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number = 2000,
  temperature: number = 0.5
) {
  const client = getClient();
  const models = MODELS;

  let lastErr: any = null;

  for (const model of models) {
    try {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: "json_object" },
        messages,
      });

      const rawText = completion.choices[0]?.message?.content?.trim() || "";
      return extractJSON(rawText);
    } catch (err: any) {
      console.warn(`Model ${model} error: ${err.message}. Trying next fallback...`);
      lastErr = err;

      // If rate limited or context overflow, attempt once with tighter token window
      if (err?.status === 413 || err?.status === 429) {
        try {
          const retryCompletion = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 1200),
            temperature,
            response_format: { type: "json_object" },
            messages,
          });
          const rawText = retryCompletion.choices[0]?.message?.content?.trim() || "";
          return extractJSON(rawText);
        } catch {
          // Continue to next model
        }
      }
    }
  }

  throw lastErr || new Error("Failed to get valid response from AI models.");
}

export async function callAIChatText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number = 1800,
  temperature: number = 0.6
): Promise<string> {
  const client = getClient();
  const models = CHAT_MODELS;

  let lastErr: any = null;

  for (const model of models) {
    try {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
      });

      const rawText = completion.choices[0]?.message?.content?.trim() || "";
      if (rawText) {
        return rawText;
      }
    } catch (err: any) {
      console.warn(`Chat model ${model} error: ${err.message}. Trying next fallback...`);
      lastErr = err;

      if (err?.status === 413 || err?.status === 429) {
        try {
          const retryCompletion = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 1000),
            temperature,
            messages,
          });
          const rawText = retryCompletion.choices[0]?.message?.content?.trim() || "";
          if (rawText) return rawText;
        } catch {
          // Continue to next
        }
      }
    }
  }

  throw lastErr || new Error("Failed to get response from AI chat models.");
}
