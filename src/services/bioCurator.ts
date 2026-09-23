import { completeJson, aiIsAvailable, AiUnavailableError } from "./ai";
import { CATEGORIES, CAREER_STAGES } from "../types/domain";
import type { OnboardingSessionDoc, OnboardingTopic } from "../models/OnboardingSession";

/** what the curator hands back on every turn. */
export interface CuratorTurn {
  /** the next thing the curator says */
  message: string;
  /** set when the last answer was too thin, with a concrete example attached */
  critique: string | null;
  /** quick replies the client renders as pills, empty when free text is wanted */
  suggestions: string[];
  /** true when this topic expects a multi select rather than a sentence */
  multiSelect: boolean;
  topic: OnboardingTopic;
  extracted: Record<string, unknown>;
  /** true once there is enough to write a real bio */
  complete: boolean;
  bio: string | null;
}

const USER_SYSTEM = `you are a professional bio curator for updatebase, a platform where people
follow communities that post opportunities like scholarships, internships, jobs and hackathons.

your job is a short conversation that ends in a bio worth reading. you are talking to one person.

how you work:
- ask one question at a time. never stack two questions into one message.
- work through these topics in a sensible order, skipping what you already know:
  interests, specifics, stage, background, accomplishments, goals.
- when an answer is thin, vague or does not answer what you asked, say so kindly
  and show a concrete example of a better answer. then ask again. do not accept
  "i like tech" or "nothing much" and move on.
- when an answer is good, acknowledge it in a few words and move to the next topic.
- ask a follow up when something specific is worth pulling on. a person who says
  they built something should be asked what it does or who uses it.
- decide yourself when you have enough. that usually takes six to ten exchanges.
  do not drag it out once the picture is clear.

the bio you write at the end:
- 2 to 4 sentences, first person, no headings, no bullet points
- specific. names of schools, tools, roles and real accomplishments beat adjectives.
- says what they are looking for, because that is what this platform is for
- warm and plain. no buzzwords, no "passionate about", no "results driven".
- all lowercase except proper nouns like names of schools, companies and tools.
- never invent anything they did not say.

tone: lowercase, direct, friendly. short sentences. no em dashes anywhere.

respond with json only, matching this shape exactly:
{
  "message": "your next message to them",
  "critique": "why their last answer was not enough, with an example, or null",
  "suggestions": ["pill", "options"],
  "multiSelect": false,
  "topic": "interests | specifics | stage | background | accomplishments | goals | review",
  "extracted": {
    "interests": ["from the allowed list only"],
    "interestDetail": "what specifically within those areas",
    "careerStage": "one of the allowed stages",
    "school": "",
    "company": "",
    "profession": "",
    "yearsOfExperience": 0,
    "accomplishments": "",
    "shortTermGoal": "",
    "longTermGoal": ""
  },
  "complete": false,
  "bio": null
}

only include keys in "extracted" that you actually learned. leave the rest out.
set "complete" to true and fill "bio" only on the final turn.`;

const ORG_SYSTEM = `you are a professional bio curator for updatebase, a platform where communities
post opportunities like scholarships, internships, jobs and hackathons.

you are talking to whoever runs a community, helping them describe it so the right
people choose to follow it.

work through these topics, one question at a time:
- who the community is for, specifically. "students" is not enough, "final year
  engineering students in nigeria looking for their first role" is.
- what they post, and how often
- where the community already lives, for example a whatsapp group or a channel,
  and roughly how many people are in it
- what makes it different from the other places posting the same links
- the voice they post in, since the composer will learn from this
- when it started and who started it

same rules as always: one question at a time, push back on thin answers with a
concrete example of a better one, follow up on anything specific, and stop once
the picture is clear. usually five to eight exchanges.

the bio you write:
- 2 to 3 sentences, written as the community, not as a person
- says who it is for and what they will get by following
- specific numbers and places where they gave them
- plain and warm, no marketing language
- all lowercase except proper nouns
- never invent anything

tone: lowercase, direct. no em dashes.

respond with json only:
{
  "message": "your next message",
  "critique": "why the last answer was not enough, with an example, or null",
  "suggestions": [],
  "multiSelect": false,
  "topic": "interests | specifics | stage | background | accomplishments | goals | review",
  "extracted": { "audience": "", "posts": "", "voice": "", "founded": "" },
  "complete": false,
  "bio": null
}`;

/** the opener, so the first screen never has to wait on a model call. */
export function openingTurn(subjectType: "user" | "organization"): CuratorTurn {
  if (subjectType === "organization") {
    return {
      message:
        "let's write your community's bio. first, who is it actually for? be specific, something like \"final year engineering students in akure looking for their first role\" tells me far more than \"students\".",
      critique: null,
      suggestions: [],
      multiSelect: false,
      topic: "interests",
      extracted: {},
      complete: false,
      bio: null,
    };
  }

  return {
    message:
      "let's get your profile sorted. what kind of opportunities do you want to hear about? pick as many as apply.",
    critique: null,
    suggestions: [...CATEGORIES],
    multiSelect: true,
    topic: "interests",
    extracted: {},
    complete: false,
    bio: null,
  };
}

interface RawTurn {
  message?: string;
  critique?: string | null;
  suggestions?: unknown;
  multiSelect?: boolean;
  topic?: string;
  extracted?: Record<string, unknown>;
  complete?: boolean;
  bio?: string | null;
}

const TOPICS = new Set([
  "interests",
  "specifics",
  "stage",
  "background",
  "accomplishments",
  "goals",
  "review",
]);

/** the model is asked for a shape, but we never trust that it sent one. */
function normalize(raw: RawTurn, fallbackTopic: OnboardingTopic): CuratorTurn {
  const topic = (
    typeof raw.topic === "string" && TOPICS.has(raw.topic) ? raw.topic : fallbackTopic
  ) as OnboardingTopic;

  const extracted = raw.extracted && typeof raw.extracted === "object" ? raw.extracted : {};

  // the model can only choose from our list, never invent a category
  if (Array.isArray(extracted.interests)) {
    extracted.interests = (extracted.interests as unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase().trim())
      .filter((value) => (CATEGORIES as readonly string[]).includes(value));
  }

  if (
    typeof extracted.careerStage === "string" &&
    !(CAREER_STAGES as readonly string[]).includes(extracted.careerStage)
  ) {
    delete extracted.careerStage;
  }

  const complete = raw.complete === true && typeof raw.bio === "string" && raw.bio.length > 40;

  return {
    message: typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : "tell me a bit more about that.",
    critique: typeof raw.critique === "string" && raw.critique.trim() ? raw.critique.trim() : null,
    suggestions: Array.isArray(raw.suggestions)
      ? raw.suggestions.filter((value): value is string => typeof value === "string").slice(0, 14)
      : [],
    multiSelect: raw.multiSelect === true,
    topic: complete ? "review" : topic,
    extracted,
    complete,
    bio: complete ? (raw.bio as string).trim() : null,
  };
}

/**
 * runs one exchange. the whole conversation goes back to the model every turn,
 * which is what lets it ask a follow up that actually refers to what was said
 * five messages ago rather than restarting each time.
 */
export async function curatorTurn(
  session: OnboardingSessionDoc,
  userMessage: string,
): Promise<CuratorTurn> {
  if (!aiIsAvailable()) {
    throw new AiUnavailableError("no_key", "the guided setup needs ai, which is not configured");
  }

  const system = session.subjectType === "organization" ? ORG_SYSTEM : USER_SYSTEM;

  const history = session.turns.map((turn) => ({
    role: turn.role as "user" | "assistant",
    content: turn.content,
  }));

  // telling the model what it already has stops it asking the same thing twice
  const known = JSON.stringify(session.extracted ?? {});
  const context = `what you already know about them: ${known}
topics you have covered: ${(session.covered ?? []).join(", ") || "none yet"}
exchanges so far: ${history.length}`;

  const raw = await completeJson<RawTurn>({
    system: `${system}\n\n---\n${context}`,
    messages: [...history, { role: "user", content: userMessage }],
    temperature: 0.8,
    maxTokens: 1200,
  });

  return normalize(raw, (session.currentTopic as OnboardingTopic) ?? "interests");
}

/**
 * rewrites the bio from everything gathered, without another question. used by
 * the review screen after someone edits an earlier answer.
 */
export async function rewriteBio(session: OnboardingSessionDoc): Promise<string> {
  if (!aiIsAvailable()) {
    throw new AiUnavailableError("no_key", "writing the bio needs ai, which is not configured");
  }

  const system = session.subjectType === "organization" ? ORG_SYSTEM : USER_SYSTEM;

  const result = await completeJson<RawTurn>({
    system,
    messages: [
      {
        role: "user",
        content: `write the final bio now from exactly this, and nothing else:
${JSON.stringify(session.extracted ?? {}, null, 2)}

respond with json where "complete" is true, "bio" holds the bio, "message" is a
single short line introducing it, and every other field is empty or null.`,
      },
    ],
    temperature: 0.7,
    maxTokens: 700,
  });

  const bio = typeof result.bio === "string" ? result.bio.trim() : "";
  if (bio.length < 40) {
    throw new AiUnavailableError("upstream", "the bio came back too short, try again");
  }
  return bio;
}
