export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompleteOptions {
  /** the instruction block. providers place this differently, adapters handle it. */
  system: string;
  messages: AiMessage[];
  /** ask the model to return json only. adapters set the right flag per vendor. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  readonly name: string;
  /** false when the key is missing, so the caller can fall back without trying */
  readonly configured: boolean;
  complete(options: AiCompleteOptions): Promise<string>;
}

export class AiUnavailableError extends Error {
  readonly reason: "no_key" | "quota" | "timeout" | "upstream";

  constructor(reason: AiUnavailableError["reason"], message: string) {
    super(message);
    this.name = "AiUnavailableError";
    this.reason = reason;
  }
}
