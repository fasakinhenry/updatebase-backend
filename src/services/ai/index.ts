import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { createOpenAiProvider } from "./openai";
import { AiUnavailableError, type AiCompleteOptions, type AiProvider } from "./types";

export * from "./types";

function build(): AiProvider {
  switch (env.AI_PROVIDER) {
    case "openai":
      return createOpenAiProvider();
    case "anthropic":
      return createAnthropicProvider();
    case "gemini":
      return createGeminiProvider();
    case "fallback":
      return {
        name: "fallback",
        configured: false,
        async complete() {
          throw new AiUnavailableError("no_key", "ai is switched off by configuration");
        },
      };
  }
}

let provider: AiProvider | null = null;

export function aiProvider(): AiProvider {
  provider ??= build();
  return provider;
}

/** true when a real model is reachable, so callers can pick a path up front. */
export function aiIsAvailable(): boolean {
  return aiProvider().configured;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiUnavailableError("timeout", "the ai took too long to answer")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * one call in, text out. handles the timeout and a single retry for transient
 * upstream failures. a quota error is never retried, because the second call
 * fails exactly the same way and just costs the user another wait.
 */
export async function complete(options: AiCompleteOptions): Promise<string> {
  const current = aiProvider();

  if (!current.configured) {
    throw new AiUnavailableError("no_key", `${current.name} has no api key configured`);
  }

  try {
    return await withTimeout(current.complete(options), env.AI_TIMEOUT_MS);
  } catch (error) {
    const retryable =
      error instanceof AiUnavailableError &&
      (error.reason === "upstream" || error.reason === "timeout");

    if (!retryable) throw error;

    logger.warn({ provider: current.name }, "ai call failed, retrying once");
    return withTimeout(current.complete(options), env.AI_TIMEOUT_MS);
  }
}

/**
 * the same call, but json parsed. models still sometimes wrap json in a fenced
 * code block no matter what you ask, so we strip that before parsing.
 */
export async function completeJson<T>(options: AiCompleteOptions): Promise<T> {
  const raw = await complete({ ...options, json: true });

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AiUnavailableError("upstream", "the ai returned something we could not read");
  }
}
