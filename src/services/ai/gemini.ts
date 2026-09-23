import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env";
import { AiUnavailableError, type AiCompleteOptions, type AiProvider } from "./types";

/**
 * the default provider. gemini's free tier is the one that lets this project
 * exist without a card on file, so it is what everything is tuned against.
 */
export function createGeminiProvider(): AiProvider {
  const configured = Boolean(env.GEMINI_API_KEY);
  const client = configured ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;

  return {
    name: "gemini",
    configured,

    async complete({ system, messages, json, temperature = 0.7, maxTokens = 2048 }: AiCompleteOptions) {
      if (!client) throw new AiUnavailableError("no_key", "GEMINI_API_KEY is not set");

      try {
        const response = await client.models.generateContent({
          model: env.AI_MODEL,
          contents: messages.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
          config: {
            systemInstruction: system,
            temperature,
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: "application/json" } : {}),
          },
        });

        const text = response.text;
        if (!text) throw new AiUnavailableError("upstream", "gemini returned an empty response");
        return text;
      } catch (error) {
        throw normalizeGeminiError(error);
      }
    },
  };
}

function normalizeGeminiError(error: unknown): Error {
  if (error instanceof AiUnavailableError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (/quota|rate limit|429|RESOURCE_EXHAUSTED/i.test(message)) {
    return new AiUnavailableError("quota", "the ai free tier is used up for now");
  }
  if (/timeout|ETIMEDOUT|aborted/i.test(message)) {
    return new AiUnavailableError("timeout", "the ai took too long to answer");
  }
  return new AiUnavailableError("upstream", message);
}
