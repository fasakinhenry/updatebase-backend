import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import {
  OnboardingSession,
  extractedOf,
  type OnboardingSessionDoc,
  type OnboardingTopic,
} from "../models/OnboardingSession";
import { AiRuleSet } from "../models/AiRuleSet";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { requireRole } from "../middleware/membership";
import { validate } from "../middleware/validate";
import { aiLimiter, writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok } from "../utils/respond";
import { badRequest, serviceUnavailable } from "../utils/errors";
import { AiUnavailableError } from "../services/ai";
import { curatorTurn, openingTurn, rewriteBio } from "../services/bioCurator";

export const orgOnboardingRouter = Router();

orgOnboardingRouter.use(requireAuth, requireOnboarded);

const idParam = z.object({
  organizationId: z.string().refine(Types.ObjectId.isValid, "not a valid id"),
});

function aiError(error: unknown): never {
  if (error instanceof AiUnavailableError) {
    throw serviceUnavailable(
      error.reason === "quota"
        ? "the ai is out of free requests for now. try again in a few minutes, or write the bio yourself."
        : "the guided setup is unavailable right now. you can write the bio yourself instead.",
      `ai_${error.reason}`,
    );
  }
  throw error;
}

async function loadSession(organizationId: Types.ObjectId): Promise<OnboardingSessionDoc> {
  const existing = await OnboardingSession.findOne({
    subjectType: "organization",
    subject: organizationId,
  });
  if (existing) return existing;

  const opening = openingTurn("organization");

  return OnboardingSession.create({
    subjectType: "organization",
    subject: organizationId,
    currentTopic: "interests",
    turns: [{ role: "assistant", content: opening.message, topic: opening.topic }],
  });
}

function view(session: OnboardingSessionDoc) {
  return {
    turns: session.turns.map((turn) => ({
      id: String(turn._id),
      role: turn.role,
      content: turn.content,
      topic: turn.topic,
      critique: turn.critique,
      at: turn.at,
    })),
    extracted: session.extracted,
    covered: session.covered,
    currentTopic: session.currentTopic,
    draftBio: session.draftBio,
    complete: Boolean(session.completedAt),
  };
}

orgOnboardingRouter.get(
  "/:organizationId/conversation",
  validate({ params: idParam }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.organization!._id);
    return ok(res, { ...view(session), suggestions: [], multiSelect: false });
  }),
);

orgOnboardingRouter.post(
  "/:organizationId/conversation",
  aiLimiter,
  validate({
    params: idParam,
    body: z.object({ message: z.string().trim().min(1, "say something first").max(2000) }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.organization!._id);

    if (session.completedAt) throw badRequest("this conversation is already finished");

    session.turns.push({
      role: "user",
      content: req.body.message,
      topic: session.currentTopic,
    });

    let turn;
    try {
      turn = await curatorTurn(session, req.body.message);
    } catch (error) {
      aiError(error);
    }

    // merge, so a later answer never wipes an earlier one
    for (const [key, value] of Object.entries(turn.extracted)) {
      if (value === null || value === undefined || value === "") continue;
      session.set(`extracted.${key}`, value);
    }

    if (!turn.critique && session.currentTopic && !session.covered.includes(session.currentTopic)) {
      session.covered.push(session.currentTopic);
    }

    session.turns.push({
      role: "assistant",
      content: turn.message,
      topic: turn.topic,
      critique: turn.critique,
    });
    session.currentTopic = turn.topic;

    if (turn.complete && turn.bio) session.draftBio = turn.bio;

    await session.save();

    return ok(res, {
      ...view(session),
      suggestions: turn.suggestions,
      multiSelect: turn.multiSelect,
      critique: turn.critique,
      complete: turn.complete,
    });
  }),
);

orgOnboardingRouter.post(
  "/:organizationId/conversation/revise",
  aiLimiter,
  validate({
    params: idParam,
    body: z.object({
      topic: z.enum(["interests", "specifics", "stage", "background", "accomplishments", "goals"]),
    }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.organization!._id);
    const topic = req.body.topic as OnboardingTopic;

    session.covered = session.covered.filter((entry) => entry !== topic);
    session.currentTopic = topic;
    session.completedAt = null;

    let turn;
    try {
      turn = await curatorTurn(
        session,
        `i want to change my answer about ${topic}. ask me about it again.`,
      );
    } catch (error) {
      aiError(error);
    }

    session.turns.push({ role: "assistant", content: turn.message, topic });
    await session.save();

    return ok(res, { ...view(session), suggestions: turn.suggestions, multiSelect: false });
  }),
);

orgOnboardingRouter.post(
  "/:organizationId/conversation/rewrite-bio",
  aiLimiter,
  validate({ params: idParam }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.organization!._id);

    let bio: string;
    try {
      bio = await rewriteBio(session);
    } catch (error) {
      aiError(error);
    }

    session.draftBio = bio;
    await session.save();

    return ok(res, { bio });
  }),
);

orgOnboardingRouter.post(
  "/:organizationId/conversation/complete",
  writeLimiter,
  validate({
    params: idParam,
    body: z.object({
      bio: z.string().trim().min(40, "that bio is too short").max(600),
      tagline: z.string().trim().max(120).optional(),
    }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;
    const session = await loadSession(organization._id);
    const extracted = extractedOf(session);

    organization.bio = req.body.bio;
    if (req.body.tagline) organization.tagline = req.body.tagline;
    await organization.save();

    // the voice they described is exactly what the formatter needs to hear, so
    // it goes straight into the rule set rather than being asked for twice
    if (extracted.voice) {
      const rules = await AiRuleSet.findOne({ organization: organization._id });
      if (rules && !rules.customPrompt) {
        rules.customPrompt = `the voice this community posts in: ${extracted.voice}`;
        await rules.save();
      }
    }

    session.draftBio = req.body.bio;
    session.completedAt = new Date();
    await session.save();

    return ok(res, organization.toJSON());
  }),
);
