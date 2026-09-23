import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { AiUnavailableError, type AiCompleteOptions, type AiProvider } from "./types";

export function createAnthropicProvider(): AiProvider {
  const configured = Boolean(env.ANTHROPIC_API_KEY);
  const client = configured
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.AI_TIMEOUT_MS })
    : null;

  return {
    name: "anthropic",
    configured,

    async complete({ system, messages, json, temperature = 0.7, maxTokens = 2048 }: AiCompleteOptions) {
      if (!client) throw new AiUnavailableError("no_key", "ANTHROPIC_API_KEY is not set");

      try {
        const response = await client.messages.create({
          model: env.AI_MODEL,
          system,
          temperature,
          max_tokens: maxTokens,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          // claude has no json mode, so we prefill the opening brace and the
          // model continues from there
          ...(json ? { stop_sequences: [] } : {}),
        });

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        if (!text) throw new AiUnavailableError("upstream", "anthropic returned an empty response");
        return text;
      } catch (error) {
        throw normalizeAnthropicError(error);
      }
    },
  };
}

function normalizeAnthropicError(error: unknown): Error {
  if (error instanceof AiUnavailableError) return error;

  if (error instanceof Anthropic.APIError) {
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
