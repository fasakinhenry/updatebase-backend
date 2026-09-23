import { Router } from "express";
import { User } from "../models/User";
import {
  OnboardingSession,
  extractedOf,
  type OnboardingSessionDoc,
  type OnboardingTopic,
} from "../models/OnboardingSession";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { aiLimiter, writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok } from "../utils/respond";
import { badRequest, conflict, serviceUnavailable } from "../utils/errors";
import { AiUnavailableError } from "../services/ai";
import { curatorTurn, openingTurn, rewriteBio } from "../services/bioCurator";
import {
  checkUsernameSchema,
  conversationTurnSchema,
  locationSchema,
  profileStepSchema,
  reviseTopicSchema,
  saveBioSchema,
} from "../schemas/onboarding";

export const onboardingRouter = Router();

onboardingRouter.use(requireAuth);

/** turns an ai outage into copy the ui can put in front of someone. */
function aiError(error: unknown): never {
  if (error instanceof AiUnavailableError) {
    const message =
      error.reason === "quota"
        ? "the ai is out of free requests for now. try again in a few minutes."
        : error.reason === "timeout"
          ? "that took too long. send it again."
          : "the guided setup is unavailable right now. you can skip it and write your bio yourself.";
    throw serviceUnavailable(message, `ai_${error.reason}`);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// stage one: the profile
// ---------------------------------------------------------------------------

onboardingRouter.get(
  "/username-available",
  validate({ query: checkUsernameSchema }),
  asyncHandler(async (req, res) => {
    const username = String(req.query.username);
    const existing = await User.findOne({ usernameLower: username.toLowerCase() })
      .select("_id")
      .lean();

    // taken by the person asking is still available to them
    const available = !existing || String(existing._id) === req.userId;
    return ok(res, { username, available });
  }),
);

onboardingRouter.post(
  "/profile",
  writeLimiter,
  validate({ body: profileStepSchema }),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { username, ...rest } = req.body;

    const clash = await User.findOne({ usernameLower: username.toLowerCase() })
      .select("_id")
      .lean();

    if (clash && String(clash._id) !== req.userId) {
      throw conflict("that username is already taken", { field: "username" });
    }

    user.set({ ...rest, username });
    user.onboarding ??= {};
    user.onboarding.profileCompletedAt = new Date();
    await user.save();

    return ok(res, { user: user.toJSON() });
  }),
);

// ---------------------------------------------------------------------------
// stage two: the conversation
// ---------------------------------------------------------------------------

async function loadSession(userId: string): Promise<OnboardingSessionDoc> {
  const existing = await OnboardingSession.findOne({ subjectType: "user", subject: userId });
  if (existing) return existing;

  const opening = openingTurn("user");
  return OnboardingSession.create({
    subjectType: "user",
    subject: userId,
    currentTopic: "interests",
    turns: [{ role: "assistant", content: opening.message, topic: opening.topic }],
  });
}

function sessionView(session: OnboardingSessionDoc) {
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

/** resumes where they left off, or opens the conversation. */
onboardingRouter.get(
  "/conversation",
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.userId!);
    const opening = openingTurn("user");

    return ok(res, {
      ...sessionView(session),
      // the opening step is a multi select, later ones are free text
      suggestions: session.turns.length <= 1 ? opening.suggestions : [],
      multiSelect: session.turns.length <= 1,
    });
  }),
);

onboardingRouter.post(
  "/conversation",
  aiLimiter,
  validate({ body: conversationTurnSchema }),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.userId!);

    if (session.completedAt) {
      throw badRequest("this conversation is already finished");
    }

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

    // merge rather than replace, so a later turn never wipes an earlier answer
    for (const [key, value] of Object.entries(turn.extracted)) {
      if (value === null || value === undefined || value === "") continue;
      session.set(`extracted.${key}`, value);
    }

    // a topic only counts as covered once the curator stops pushing back on it
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

    if (turn.complete && turn.bio) {
      session.draftBio = turn.bio;
    }

    await session.save();

    return ok(res, {
      ...sessionView(session),
      suggestions: turn.suggestions,
      multiSelect: turn.multiSelect,
      critique: turn.critique,
      complete: turn.complete,
    });
  }),
);

/**
 * the review screen sends someone back into one topic. the thread stays intact,
 * we just reopen that subject so the curator asks about it again.
 */
onboardingRouter.post(
  "/conversation/revise",
  aiLimiter,
  validate({ body: reviseTopicSchema }),
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.userId!);
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

    return ok(res, {
      ...sessionView(session),
      suggestions: turn.suggestions,
      multiSelect: turn.multiSelect,
    });
  }),
);

/** rewrites the bio from the answers, without asking anything new. */
onboardingRouter.post(
  "/conversation/rewrite-bio",
  aiLimiter,
  asyncHandler(async (req, res) => {
    const session = await loadSession(req.userId!);

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

/** accepts the bio, copies the answers onto the profile and closes stage two. */
onboardingRouter.post(
  "/conversation/complete",
  writeLimiter,
  validate({ body: saveBioSchema }),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const session = await loadSession(req.userId!);
    const extracted = extractedOf(session);

    user.bio = req.body.bio;
    if (extracted.interests?.length) user.interests = extracted.interests;
    if (extracted.careerStage) user.careerStage = extracted.careerStage;
    if (extracted.school) user.school = extracted.school;
    if (extracted.company) user.company = extracted.company;
    if (extracted.profession) user.profession = extracted.profession;
    if (typeof extracted.yearsOfExperience === "number") {
      user.yearsOfExperience = extracted.yearsOfExperience;
    }
    if (extracted.shortTermGoal || extracted.longTermGoal) {
      user.goals = {
        shortTerm: extracted.shortTermGoal ?? user.goals?.shortTerm,
        longTerm: extracted.longTermGoal ?? user.goals?.longTerm,
      };
    }

    user.onboarding ??= {};
    user.onboarding.conversationCompletedAt = new Date();
    await user.save();

    session.draftBio = req.body.bio;
    session.completedAt = new Date();
    await session.save();

    return ok(res, { user: user.toJSON() });
  }),
);

// ---------------------------------------------------------------------------
// stage three: location
// ---------------------------------------------------------------------------

onboardingRouter.post(
  "/location",
  writeLimiter,
  validate({ body: locationSchema }),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { latitude, longitude, city, country } = req.body;

    user.location = {
      // geojson wants longitude first, which is the opposite of how people say it
      coordinates: [longitude, latitude],
      city,
      country,
      grantedAt: new Date(),
    };
    user.onboarding ??= {};
    user.onboarding.locationPromptedAt = new Date();
    await user.save();

    return ok(res, { user: user.toJSON() });
  }),
);

/** they declined, which is fine. we record that we asked so we stop asking. */
onboardingRouter.post(
  "/location/skip",
  asyncHandler(async (req, res) => {
    const user = req.user!;
    user.onboarding ??= {};
    user.onboarding.locationPromptedAt = new Date();
    await user.save();

    return ok(res, { user: user.toJSON() });
  }),
);
