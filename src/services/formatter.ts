import { completeJson, aiIsAvailable, AiUnavailableError } from "./ai";
import { CATEGORIES, CATEGORY_HEADERS, type Category } from "../types/domain";
import type { AiRuleSetDoc } from "../models/AiRuleSet";

export interface FormatInput {
  /** whatever they pasted, in whatever state it arrived */
  raw: string;
  /** the number this update will carry */
  number: number;
  /** the delegate's username, for the signature */
  username: string;
  organizationName: string;
  /** set to re-shape an already formatted update, e.g. "make it shorter" */
  instruction?: string;
  /** the previous result, when an instruction is refining rather than starting */
  previous?: string;
}

export interface FormatResult {
  header: string;
  body: string;
  category: Category;
  link: string | null;
  tags: string[];
  deadline: string | null;
  footer: string;
  /** true when this came from the rule based path rather than a model */
  deterministic: boolean;
}

// ---------------------------------------------------------------------------
// the deterministic path
// ---------------------------------------------------------------------------

/** words that reliably signal a category, checked in priority order. */
const SIGNALS: [Category, RegExp][] = [
  ["scholarships", /\bscholarship|bursary|tuition waiver|fully funded (?:study|degree)/i],
  ["hackathons", /\bhackathon|hack ?day|devpost|build.?athon/i],
  ["internships", /\bintern(ship)?\b|industrial training|siwes/i],
  ["fellowships", /\bfellowship|fellow program/i],
  ["grants", /\bgrant\b|funding for|seed fund/i],
  ["bounties", /\bbounty|bounties|paid issue/i],
  ["competitions", /\bcompetition|contest|challenge|pitch/i],
  ["conferences", /\bconference|summit/i],
  ["volunteering", /\bvolunteer|pro bono/i],
  ["events", /\bwebinar|workshop|bootcamp|meetup|masterclass|event\b/i],
  ["jobs", /\b(?:hiring|job|role|position|vacancy|recruit|full.?time)\b/i],
  ["career", /\bmentorship|career|cv review|resume/i],
];

export function inferCategory(text: string): Category {
  for (const [category, pattern] of SIGNALS) {
    if (pattern.test(text)) return category;
  }
  return "alpha";
}

export function extractLink(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return match ? match[0].replace(/[.,;:]$/, "") : null;
}

/** pulls a closing date out of the kind of phrasing these posts actually use. */
export function extractDeadline(text: string): Date | null {
  const patterns = [
    /(?:deadline|closes?|apply before|ends?|due)\s*(?:on|by|:)?\s*([a-z]+\s+\d{1,2}(?:,?\s*\d{4})?)/i,
    /(?:deadline|closes?|apply before|ends?|due)\s*(?:on|by|:)?\s*(\d{1,2}\s+[a-z]+(?:\s+\d{4})?)/i,
    /(?:deadline|closes?|apply before|ends?|due)\s*(?:on|by|:)?\s*(\d{4}-\d{2}-\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const parsed = new Date(match[1]);
    if (Number.isNaN(parsed.getTime())) continue;

    // a date with no year parses into the current one, which may be in the past
    if (parsed.getTime() < Date.now()) parsed.setFullYear(parsed.getFullYear() + 1);
    return parsed;
  }

  return null;
}

function buildSignature(rules: AiRuleSetDoc | null, username: string, organizationName: string) {
  const template = rules?.signatureTemplate ?? "{username} from {organization}";
  return template.replace("{username}", username).replace("{organization}", organizationName);
}

function buildFooter(rules: AiRuleSetDoc | null, username: string, organizationName: string) {
  const parts: string[] = [];
  if (rules?.footer) parts.push(rules.footer);
  parts.push(buildSignature(rules, username, organizationName));
  return parts.join("\n\n");
}

/**
 * formatting with no model at all.
 *
 * this is not a placeholder. when the free ai quota runs out mid session the
 * composer still has to work, so this path trims the paste to its useful
 * sentences, applies the casing rule, and keeps the number, link and footer
 * exactly where the ai path would put them.
 */
export function deterministicFormat(input: FormatInput, rules: AiRuleSetDoc | null): FormatResult {
  const category = inferCategory(input.raw);
  const link = extractLink(input.raw);
  const deadline = extractDeadline(input.raw);

  const header =
    (rules?.categoryHeaders?.get(category) as string | undefined) ?? CATEGORY_HEADERS[category];

  const sentences = input.raw
    .replace(/https?:\/\/\S+/g, "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);

  // the first few sentences carry the offer, the rest is usually preamble
  let body = sentences.slice(0, 4).join(" ").replace(/\s+/g, " ").trim();
  if (!body) body = input.raw.replace(/\s+/g, " ").trim().slice(0, 400);

  if (rules?.lowercase !== false) body = body.toLowerCase();

  return {
    header,
    body,
    category,
    link,
    tags: [category],
    deadline: deadline?.toISOString() ?? null,
    footer: buildFooter(rules, input.username, input.organizationName),
    deterministic: true,
  };
}

// ---------------------------------------------------------------------------
// the ai path
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  rules: AiRuleSetDoc | null,
  organizationName: string,
  username: string,
): string {
  const lines: string[] = [
    `you format opportunity updates for ${organizationName}, a community that shares`,
    `scholarships, jobs, hackathons and similar things with its members.`,
    ``,
    `someone pastes a raw opportunity. you return it as an update their community`,
    `will actually read: only the parts that matter, in this community's voice.`,
    ``,
    `always:`,
    `- keep only what a reader needs to decide whether to apply. drop the marketing.`,
    `- lead with what it is, then what it covers, then who can apply, then when it closes.`,
    `- short lines. no paragraphs longer than two sentences.`,
    `- never invent a detail that is not in what they pasted. if a deadline is not`,
    `  stated, leave it null rather than guessing one.`,
    `- no em dashes anywhere.`,
  ];

  if (rules?.lowercase !== false) {
    lines.push(
      `- write the body in lowercase, including the first letter of sentences.`,
      `  keep proper nouns as they are: names of organizations, schools and places.`,
    );
  }

  if (rules?.emojiVocabulary?.length) {
    lines.push(
      ``,
      `this community uses these emojis. reuse them, do not introduce others:`,
      rules.emojiVocabulary.join(" "),
    );
  }

  if (rules?.rules?.length) {
    lines.push(``, `rules this community has set, which override anything above:`);
    for (const rule of rules.rules) lines.push(`- ${rule}`);
  }

  if (rules?.customPrompt) {
    lines.push(``, `extra instructions:`, rules.customPrompt);
  }

  if (rules?.examples?.length) {
    lines.push(
      ``,
      `worked examples. match this style closely, it matters more than the rules above:`,
    );
    // the three most recent teach the current voice, older ones drift
    for (const example of rules.examples.slice(-3)) {
      lines.push(``, `pasted:`, example.input, ``, `became:`, example.output);
      if (example.note) lines.push(`note: ${example.note}`);
    }
  }

  lines.push(
    ``,
    `the signature is added separately, so do not write "${username} from ${organizationName}"`,
    `into the body yourself.`,
    ``,
    `respond with json only:`,
    `{`,
    `  "header": "the category line with its emoji, e.g. 🎓 scholarship update",`,
    `  "body": "the update itself, newlines and all",`,
    `  "category": "one of: ${CATEGORIES.join(", ")}",`,
    `  "link": "the application url, or null",`,
    `  "tags": ["three", "lowercase", "tags"],`,
    `  "deadline": "iso date, or null if none was stated"`,
    `}`,
  );

  return lines.join("\n");
}

interface RawFormat {
  header?: string;
  body?: string;
  category?: string;
  link?: string | null;
  tags?: unknown;
  deadline?: string | null;
}

export async function formatUpdate(
  input: FormatInput,
  rules: AiRuleSetDoc | null,
): Promise<FormatResult> {
  if (!aiIsAvailable()) return deterministicFormat(input, rules);

  const system = buildSystemPrompt(rules, input.organizationName, input.username);

  const userMessage = input.instruction
    ? [
        `here is the update as it stands:`,
        input.previous ?? input.raw,
        ``,
        `change it like this: ${input.instruction}`,
        ``,
        `return the whole thing again in the same json shape.`,
      ].join("\n")
    : [`format this:`, ``, input.raw].join("\n");

  let raw: RawFormat;
  try {
    raw = await completeJson<RawFormat>({
      system,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.6,
      maxTokens: 1600,
    });
  } catch (error) {
    // quota is the one every free tier hits. falling back beats failing.
    if (error instanceof AiUnavailableError && error.reason === "quota") {
      return deterministicFormat(input, rules);
    }
    throw error;
  }

  const category = (
    typeof raw.category === "string" && (CATEGORIES as readonly string[]).includes(raw.category)
      ? raw.category
      : inferCategory(input.raw)
  ) as Category;

  const header =
    (typeof raw.header === "string" && raw.header.trim()) ||
    (rules?.categoryHeaders?.get(category) as string | undefined) ||
    CATEGORY_HEADERS[category];

  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) return deterministicFormat(input, rules);

  // never take a deadline the model invented, or one already in the past
  let deadline: string | null = null;
  if (typeof raw.deadline === "string") {
    const parsed = new Date(raw.deadline);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
      deadline = parsed.toISOString();
    }
  }

  return {
    header,
    body,
    category,
    link: (typeof raw.link === "string" && raw.link.trim()) || extractLink(input.raw),
    tags: Array.isArray(raw.tags)
      ? raw.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.toLowerCase().trim().replace(/^#/, ""))
          .filter(Boolean)
          .slice(0, 6)
      : [category],
    deadline,
    footer: buildFooter(rules, input.username, input.organizationName),
    deterministic: false,
  };
}

/** the whole update as one block, which is what actually gets copied out. */
export function assemble(result: FormatResult, number: number, rules: AiRuleSetDoc | null): string {
  const parts: string[] = [result.header, ""];

  if (rules?.showNumber !== false) {
    parts.push(`${rules?.numberPrefix ?? "✅"} ${number}`);
  }

  parts.push(result.body);

  if (result.link) parts.push("", `🔗 ${result.link}`);
  if (result.footer) parts.push("", result.footer);

  return parts.join("\n");
}
