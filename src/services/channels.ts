import { complete, aiIsAvailable, AiUnavailableError } from "./ai";
import type { Channel } from "../types/domain";
import type { FormatResult } from "./formatter";
import { assemble } from "./formatter";
import type { AiRuleSetDoc } from "../models/AiRuleSet";

/**
 * what each platform actually wants. these are not cosmetic differences: a
 * post that reads well on whatsapp reads badly on linkedin, and x will simply
 * cut it off.
 */
export const CHANNEL_RULES: Record<Channel, { limit: number; guidance: string }> = {
  updatebase: {
    limit: 4000,
    guidance: "the canonical version. keep it exactly as formatted.",
  },
  "whatsapp-channel": {
    limit: 4000,
    guidance:
      "short lines with blank lines between them, since whatsapp renders dense text badly. " +
      "put the link on its own line. keep the number and the signature.",
  },
  "whatsapp-group": {
    limit: 4000,
    guidance:
      "the same as the channel version but slightly warmer, since a group is a conversation. " +
      "keep it scannable, people are reading it between other messages.",
  },
  x: {
    limit: 280,
    guidance:
      "must fit 280 characters including the link. lead with the hook, then three short " +
      "lines using arrows, then the link. drop the signature, the account is the byline.",
  },
  linkedin: {
    limit: 3000,
    guidance:
      "professional register and sentence case, not lowercase. a strong first line, since " +
      "everything after it is hidden behind see more. full sentences, no arrows. " +
      "end with who posted it.",
  },
  instagram: {
    limit: 2200,
    guidance:
      "a caption, not a notice. warm opening line, the details in short lines, then " +
      "link in bio rather than a url, since instagram captions are not clickable. " +
      "finish with five to eight relevant hashtags.",
  },
  facebook: {
    limit: 3000,
    guidance:
      "conversational, a little longer than the others. the link can be inline. " +
      "a question at the end invites comments, which facebook rewards.",
  },
  telegram: {
    limit: 4000,
    guidance: "much like the whatsapp channel version. markdown links are supported.",
  },
};

/**
 * shapes one already formatted update for one platform.
 *
 * when there is no model the canonical text is returned unchanged, trimmed to
 * the platform's limit. that is honest: it is still usable, just not tailored.
 */
export async function renderForChannel(
  channel: Channel,
  result: FormatResult,
  number: number,
  rules: AiRuleSetDoc | null,
): Promise<string> {
  const canonical = assemble(result, number, rules);

  if (channel === "updatebase" || !aiIsAvailable()) {
    return canonical.length > CHANNEL_RULES[channel].limit
      ? `${canonical.slice(0, CHANNEL_RULES[channel].limit - 3)}...`
      : canonical;
  }

  const spec = CHANNEL_RULES[channel];

  const system = [
    `you adapt an already written update for one platform. the substance never`,
    `changes, only the shape.`,
    ``,
    `platform: ${channel}`,
    `hard limit: ${spec.limit} characters`,
    `what it wants: ${spec.guidance}`,
    ``,
    `never invent a detail that is not already there. never drop the application`,
    `link unless the platform cannot use one. no em dashes.`,
    ``,
    `return the adapted post and nothing else. no preamble, no quotes around it.`,
  ].join("\n");

  try {
    const adapted = await complete({
      system,
      messages: [{ role: "user", content: canonical }],
      temperature: 0.6,
      maxTokens: 1200,
    });

    const trimmed = adapted.trim();

    // a model that blew the limit is worse than the canonical text
    if (!trimmed || trimmed.length > spec.limit * 1.15) return canonical.slice(0, spec.limit);

    return trimmed.length > spec.limit ? trimmed.slice(0, spec.limit) : trimmed;
  } catch (error) {
    if (error instanceof AiUnavailableError) return canonical.slice(0, spec.limit);
    throw error;
  }
}

/** renders several channels at once, so the composer fills its tabs in one call. */
export async function renderForChannels(
  channels: Channel[],
  result: FormatResult,
  number: number,
  rules: AiRuleSetDoc | null,
): Promise<Record<string, string>> {
  const rendered = await Promise.all(
    channels.map(async (channel) => {
      try {
        return [channel, await renderForChannel(channel, result, number, rules)] as const;
      } catch {
        // one platform failing should never lose the others
        return [channel, assemble(result, number, rules)] as const;
      }
    }),
  );

  return Object.fromEntries(rendered);
}
