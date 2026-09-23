import OpenAI from "openai";
import { env } from "../../config/env";
import { AiUnavailableError, type AiCompleteOptions, type AiProvider } from "./types";

export function createOpenAiProvider(): AiProvider {
  const configured = Boolean(env.OPENAI_API_KEY);
  const client = configured
    ? new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_TIMEOUT_MS })
    : null;

  return {
    name: "openai",
    configured,

    async complete({ system, messages, json, temperature = 0.7, maxTokens = 2048 }: AiCompleteOptions) {
      if (!client) throw new AiUnavailableError("no_key", "OPENAI_API_KEY is not set");

      try {
        const response = await client.chat.completions.create({
          model: env.AI_MODEL,
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" as const } } : {}),
          messages: [
            { role: "system" as const, content: system },
            ...messages.map((message) => ({ role: message.role, content: message.content })),
          ],
        });

        const text = response.choices[0]?.message?.content;
        if (!text) throw new AiUnavailableError("upstream", "openai returned an empty response");
        return text;
      } catch (error) {
        throw normalizeOpenAiError(error);
      }
    },
  };
}

function normalizeOpenAiError(error: unknown): Error {
  if (error instanceof AiUnavailableError) return error;

  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) {
      return new AiUnavailableError("quota", "the ai quota is used up for now");
    }
    return new AiUnavailableError("upstream", error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|aborted/i.test(message)) {
    return new AiUnavailableError("timeout", "the ai took too long to answer");
  }
  return new AiUnavailableError("upstream", message);
}
