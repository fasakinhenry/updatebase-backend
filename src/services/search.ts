import { completeJson, aiIsAvailable, AiUnavailableError } from "./ai";
import { CATEGORIES, type Category } from "../types/domain";

/**
 * a search query, turned into something the database can actually use.
 *
 * "remote internships for final year students that close soon" is not a
 * keyword search, it is four filters and two keywords. this is where that
 * translation happens.
 */
export interface ParsedQuery {
  /** what is left once the filters are pulled out */
  keywords: string;
  categories: Category[];
  isRemote: boolean | null;
  /** only things closing inside this many days */
  closingWithinDays: number | null;
  /** iso country code they named, if they named one */
  country: string | null;
  /** what kind of thing they are looking for */
  intent: "updates" | "people" | "organizations" | "mixed";
}

const EMPTY: ParsedQuery = {
  keywords: "",
  categories: [],
  isRemote: null,
  closingWithinDays: null,
  country: null,
  intent: "mixed",
};

/**
 * the rule based parser. runs first, always, because most searches are short
 * and obvious, and a model call for "scholarships" would be a waste of quota
 * and half a second of someone's time.
 */
export function parseLocally(query: string): ParsedQuery {
  const lower = query.toLowerCase();
  let keywords = lower;

  const categories: Category[] = [];
  for (const category of CATEGORIES) {
    // the singular form too, since people type "scholarship" far more often
    const singular = category.replace(/s$/, "");
    const pattern = new RegExp(`\\b${singular}s?\\b`, "i");

    if (pattern.test(lower)) {
      categories.push(category);
      keywords = keywords.replace(pattern, " ");
    }
  }

  const isRemote = /\bremote|anywhere|work from home\b/.test(lower) ? true : null;
  if (isRemote) keywords = keywords.replace(/\bremote|anywhere|work from home\b/g, " ");

  let closingWithinDays: number | null = null;
  if (/\bclosing soon|deadline soon|ending soon|closes soon\b/.test(lower)) {
    closingWithinDays = 7;
  } else if (/\bthis week\b/.test(lower)) {
    closingWithinDays = 7;
  } else if (/\bthis month\b/.test(lower)) {
    closingWithinDays = 30;
  }

  let intent: ParsedQuery["intent"] = "mixed";
  if (/\bpeople|users|students|someone who\b/.test(lower)) intent = "people";
  if (/\bcommunities|organizations|organisations|pages\b/.test(lower)) intent = "organizations";

  return {
    ...EMPTY,
    keywords: keywords.replace(/\s+/g, " ").trim(),
    categories,
    isRemote,
    closingWithinDays,
    intent,
  };
}

const SYSTEM = `you turn a search query into filters for an opportunities platform.

the platform carries scholarships, jobs, internships, hackathons and similar
things, posted by communities, and it also has people and communities to follow.

available categories: ${CATEGORIES.join(", ")}

pull out anything the query implies. leave a field null when the query does not
say. never guess a country or a deadline that is not there.

respond with json only:
{
  "keywords": "what is left after the filters are removed, for text search",
  "categories": [],
  "isRemote": null,
  "closingWithinDays": null,
  "country": null,
  "intent": "updates | people | organizations | mixed"
}`;

/**
 * only worth a model call when the query is long enough to carry real intent.
 * short ones are handled locally, which keeps the free quota for the searches
 * that need it.
 */
export async function parseQuery(query: string): Promise<ParsedQuery> {
  const local = parseLocally(query);

  const worthAsking = query.trim().split(/\s+/).length >= 4;
  if (!worthAsking || !aiIsAvailable()) return local;

  try {
    const raw = await completeJson<Partial<ParsedQuery>>({
      system: SYSTEM,
      messages: [{ role: "user", content: query }],
      temperature: 0.2,
      maxTokens: 400,
    });

    return {
      keywords: typeof raw.keywords === "string" ? raw.keywords.trim() : local.keywords,
      categories: Array.isArray(raw.categories)
        ? (raw.categories.filter((category) =>
            (CATEGORIES as readonly string[]).includes(category),
          ) as Category[])
        : local.categories,
      isRemote: typeof raw.isRemote === "boolean" ? raw.isRemote : local.isRemote,
      closingWithinDays:
        typeof raw.closingWithinDays === "number" && raw.closingWithinDays > 0
          ? Math.min(raw.closingWithinDays, 365)
          : local.closingWithinDays,
      country:
        typeof raw.country === "string" && raw.country.length === 2
          ? raw.country.toUpperCase()
          : local.country,
      intent:
        raw.intent === "updates" ||
        raw.intent === "people" ||
        raw.intent === "organizations" ||
        raw.intent === "mixed"
          ? raw.intent
          : local.intent,
    };
  } catch (error) {
    // search must never fail because the ai did. the local parse is a fine answer.
    if (error instanceof AiUnavailableError) return local;
    throw error;
  }
}
