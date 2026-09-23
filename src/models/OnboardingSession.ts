import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CAREER_STAGES, CATEGORIES, type CareerStage, type Category } from "../types/domain";

/**
 * the topics the curator works through. it decides the order itself, this is
 * only so the review screen can send someone back to a specific part of the
 * conversation and reopen exactly that thread.
 */
export const ONBOARDING_TOPICS = [
  "interests",
  "specifics",
  "stage",
  "background",
  "accomplishments",
  "goals",
  "review",
] as const;

export type OnboardingTopic = (typeof ONBOARDING_TOPICS)[number];

const turnSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    topic: { type: String, enum: ONBOARDING_TOPICS },
    /** set when the curator pushed back on a thin answer */
    critique: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

/**
 * one per subject: a user onboarding, or an organization writing its bio.
 * keeping it separate from the user document means a half finished
 * conversation never leaves a partial profile behind.
 */
const onboardingSessionSchema = new Schema(
  {
    subjectType: { type: String, enum: ["user", "organization"], required: true },
    subject: { type: Schema.Types.ObjectId, required: true, index: true },

    turns: [turnSchema],

    /** what the curator has pulled out of the conversation so far */
    extracted: {
      interests: [{ type: String, enum: CATEGORIES }],
      interestDetail: { type: String, maxlength: 600 },
      careerStage: { type: String, enum: CAREER_STAGES },
      school: { type: String, maxlength: 120 },
      company: { type: String, maxlength: 120 },
      profession: { type: String, maxlength: 120 },
      yearsOfExperience: { type: Number, min: 0, max: 70 },
      accomplishments: { type: String, maxlength: 800 },
      shortTermGoal: { type: String, maxlength: 400 },
      longTermGoal: { type: String, maxlength: 400 },

      // organization only
      audience: { type: String, maxlength: 400 },
      posts: { type: String, maxlength: 400 },
      voice: { type: String, maxlength: 400 },
      founded: { type: String, maxlength: 120 },
    },

    /** topics the curator considers answered well enough to move on from */
    covered: [{ type: String, enum: ONBOARDING_TOPICS }],
    currentTopic: { type: String, enum: ONBOARDING_TOPICS, default: "interests" },

    draftBio: { type: String, maxlength: 800 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

onboardingSessionSchema.index({ subjectType: 1, subject: 1 }, { unique: true });

export type OnboardingSessionAttrs = InferSchemaType<typeof onboardingSessionSchema>;
export type OnboardingSessionDoc = HydratedDocument<OnboardingSessionAttrs>;

export const OnboardingSession = model("OnboardingSession", onboardingSessionSchema);

/**
 * mongoose infers a nested path of all optional fields as `{}`, which is no use
 * to a caller. this is the real shape, and `extractedOf` is how routes read it.
 */
export interface ExtractedAnswers {
  interests?: Category[];
  interestDetail?: string;
  careerStage?: CareerStage;
  school?: string;
  company?: string;
  profession?: string;
  yearsOfExperience?: number;
  accomplishments?: string;
  shortTermGoal?: string;
  longTermGoal?: string;
  audience?: string;
  posts?: string;
  voice?: string;
  founded?: string;
}

export function extractedOf(session: OnboardingSessionDoc): ExtractedAnswers {
  return (session.extracted ?? {}) as ExtractedAnswers;
}
