import { z } from "zod";
import { CATEGORIES, CAREER_STAGES } from "../types/domain";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "at least 3 characters")
  .max(24, "24 characters at most")
  .regex(/^[a-zA-Z0-9_]+$/, "letters, numbers and underscores only")
  // these would collide with our own routes
  .refine(
    (value) =>
      !["app", "auth", "api", "admin", "onboarding", "settings", "terms", "privacy", "cookies", "discover", "feed", "me"].includes(
        value.toLowerCase(),
      ),
    { message: "that username is reserved" },
  );

export const profileStepSchema = z.object({
  name: z.string().trim().min(1, "tell us your name").max(60),
  username: usernameSchema,
  gender: z.enum(["woman", "man", "non-binary", "prefer-not-to-say"]),
  dateOfBirth: z.coerce
    .date()
    .refine((date) => date < new Date(), { message: "that date is in the future" })
    .refine(
      (date) => {
        const age = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        return age >= 16 && age <= 100;
      },
      { message: "you need to be at least 16 to use updatebase" },
    ),
  avatarSeed: z.string().min(1).max(64).optional(),
  avatarStyle: z.string().min(1).max(40).optional(),
  photoUrl: z.url().optional(),
  avatarMode: z.enum(["avatar", "photo"]).default("avatar"),
});

export const checkUsernameSchema = z.object({ username: usernameSchema });

export const conversationTurnSchema = z.object({
  /** free text, or the joined pills when the step was a multi select */
  message: z.string().trim().min(1, "say something first").max(2000),
});

/** the review screen jumps back into one topic and re-answers it. */
export const reviseTopicSchema = z.object({
  topic: z.enum(["interests", "specifics", "stage", "background", "accomplishments", "goals"]),
});

export const saveBioSchema = z.object({
  bio: z.string().trim().min(40, "that bio is too short").max(600),
});

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
});

export const interestsSchema = z.object({
  interests: z.array(z.enum(CATEGORIES)).min(1, "pick at least one"),
  careerStage: z.enum(CAREER_STAGES).optional(),
});
