import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Organization } from "../models/Organization";
import { AiRuleSet } from "../models/AiRuleSet";
import { Update } from "../models/Update";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { canPublishTo, requireRole } from "../middleware/membership";
import { validate } from "../middleware/validate";
import { aiLimiter, writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, created } from "../utils/respond";
import { badRequest, forbidden, serviceUnavailable } from "../utils/errors";
import { AiUnavailableError } from "../services/ai";
import { assemble, formatUpdate, type FormatResult } from "../services/formatter";
import { renderForChannels, CHANNEL_RULES } from "../services/channels";
import { computeUpdateScore } from "../services/ranking";
import { notifyFollowers, preview } from "../services/notify";
import { CATEGORIES, CHANNELS, type Channel } from "../types/domain";

export const composerRouter = Router();

composerRouter.use(requireAuth, requireOnboarded);

const idParam = z.object({
  organizationId: z.string().refine(Types.ObjectId.isValid, "not a valid id"),
});

function aiError(error: unknown): never {
  if (error instanceof AiUnavailableError) {
    throw serviceUnavailable(
      error.reason === "quota"
        ? "the ai is out of free requests for now. you can still write it yourself and publish."
        : "the formatter is unavailable right now. your draft is safe.",
      `ai_${error.reason}`,
    );
  }
  throw error;
}

async function rulesFor(organizationId: Types.ObjectId) {
  return (
    (await AiRuleSet.findOne({ organization: organizationId })) ??
    (await AiRuleSet.create({ organization: organizationId }))
  );
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const formatSchema = z.object({
  raw: z.string().trim().min(20, "paste a bit more than that").max(8000),
  /** set to refine an existing result rather than start over */
  instruction: z.string().trim().max(400).optional(),
  previous: z.string().trim().max(8000).optional(),
});

/**
 * paste in, formatted update out.
 *
 * this never writes anything. the composer is a canvas, so someone can format,
 * refine, and reformat as many times as they like before any of it is real.
 */
composerRouter.post(
  "/:organizationId/format",
  aiLimiter,
  validate({ params: idParam, body: formatSchema }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;
    const rules = await rulesFor(organization._id);

    let result: FormatResult;
    try {
      result = await formatUpdate(
        {
          raw: req.body.raw,
          number: organization.updateCounter + 1,
          username: req.user!.username ?? "someone",
          organizationName: organization.name,
          instruction: req.body.instruction,
          previous: req.body.previous,
        },
        rules,
      );
    } catch (error) {
      aiError(error);
    }

    const number = organization.updateCounter + 1;

    return ok(res, {
      ...result,
      number,
      assembled: assemble(result, number, rules),
      // says plainly when the ai was unavailable, rather than pretending
      usedAi: !result.deterministic,
    });
  }),
);

const renderSchema = z.object({
  header: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  category: z.enum(CATEGORIES),
  link: z.url().nullable().optional(),
  tags: z.array(z.string().max(40)).max(8).optional(),
  deadline: z.iso.datetime().nullable().optional(),
  footer: z.string().max(400).optional(),
  number: z.number().int().min(1),
  channels: z.array(z.enum(CHANNELS)).min(1).max(8),
});

/** reshapes one update for each platform it is going to. */
composerRouter.post(
  "/:organizationId/render",
  aiLimiter,
  validate({ params: idParam, body: renderSchema }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const rules = await rulesFor(req.organization!._id);
    const body = req.body as z.infer<typeof renderSchema>;

    const result: FormatResult = {
      header: body.header,
      body: body.body,
      category: body.category,
      link: body.link ?? null,
      tags: body.tags ?? [],
      deadline: body.deadline ?? null,
      footer: body.footer ?? "",
      deterministic: false,
    };

    const renderings = await renderForChannels(
      body.channels as Channel[],
      result,
      body.number,
      rules,
    );

    return ok(res, {
      renderings,
      limits: Object.fromEntries(
        body.channels.map((channel) => [channel, CHANNEL_RULES[channel as Channel].limit]),
      ),
    });
  }),
);

// ---------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------

const publishSchema = renderSchema.omit({ number: true }).extend({
  media: z
    .array(
      z.object({
        url: z.url(),
        kind: z.enum(["image", "video"]),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        alt: z.string().max(400).optional(),
        captionsUrl: z.url().optional(),
      }),
    )
    .max(4)
    .optional(),
  eligibleCountries: z.array(z.string().length(2)).max(60).optional(),
  isRemote: z.boolean().optional(),
  renderings: z.record(z.string(), z.string()).optional(),
});

composerRouter.post(
  "/:organizationId/publish",
  writeLimiter,
  validate({ params: idParam, body: publishSchema }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;
    const membership = req.membership!;
    const body = req.body as z.infer<typeof publishSchema>;

    // a delegate can only publish where they were given rights
    const notAllowed = body.channels.filter((channel) => !canPublishTo(membership, channel));
    if (notAllowed.length > 0) {
      throw forbidden(
        `you have not been given ${notAllowed.join(", ")} yet. ask an admin to add it.`,
      );
    }

    // the counter is bumped atomically, so two delegates publishing at the same
    // moment can never be handed the same number
    const counted = await Organization.findByIdAndUpdate(
      organization._id,
      { $inc: { updateCounter: 1, updateCount: 1 } },
      { new: true },
    );

    if (!counted) throw badRequest("that organization is gone");

    const update = await Update.create({
      organization: organization._id,
      author: req.userId,
      // whether the poster is credited is the organization's policy, not theirs
      attributed: organization.tipMode !== "organization",
      header: body.header,
      body: body.body,
      number: counted.updateCounter,
      footer: body.footer,
      category: body.category,
      tags: body.tags ?? [],
      link: body.link ?? undefined,
      media: body.media ?? [],
      channels: body.channels,
      renderings: body.renderings,
      deadline: body.deadline ? new Date(body.deadline) : undefined,
      eligibleCountries: body.eligibleCountries ?? [],
      isRemote: body.isRemote ?? false,
      publishedAt: new Date(),
    });

    update.rankScore = computeUpdateScore(update);
    await update.save();

    await membership.updateOne({ $inc: { updateCount: 1 } });

    // everyone following the organization hears about it, in batches, detached
    void notifyFollowers(organization._id, "organization", {
      kind: "new_update",
      actor: req.userId,
      actorOrganization: organization._id,
      subjectType: "update",
      subject: update._id,
      preview: preview(`${body.header} ${body.body}`),
      link: `/app/updates/${update._id}`,
    });

    return created(res, update.toJSON());
  }),
);

// ---------------------------------------------------------------------------
// the rule set
// ---------------------------------------------------------------------------

composerRouter.get(
  "/:organizationId/rules",
  validate({ params: idParam }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    return ok(res, (await rulesFor(req.organization!._id)).toJSON());
  }),
);

const rulesSchema = z.object({
  rules: z.array(z.string().trim().max(400)).max(30).optional(),
  lowercase: z.boolean().optional(),
  footer: z.string().trim().max(400).optional(),
  signatureTemplate: z.string().trim().max(120).optional(),
  showNumber: z.boolean().optional(),
  numberPrefix: z.string().max(8).optional(),
  emojiVocabulary: z.array(z.string().max(8)).max(30).optional(),
  categoryHeaders: z.record(z.enum(CATEGORIES), z.string().max(120)).optional(),
  customPrompt: z.string().trim().max(2000).optional(),
});

composerRouter.patch(
  "/:organizationId/rules",
  writeLimiter,
  validate({ params: idParam, body: rulesSchema }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const rules = await rulesFor(req.organization!._id);
    rules.set({ ...req.body, updatedBy: req.userId });
    await rules.save();

    return ok(res, rules.toJSON());
  }),
);

const exampleSchema = z.object({
  input: z.string().trim().min(10).max(4000),
  output: z.string().trim().min(10).max(4000),
  note: z.string().trim().max(200).optional(),
});

/** a worked example teaches the formatter far more than a written rule does. */
composerRouter.post(
  "/:organizationId/rules/examples",
  writeLimiter,
  validate({ params: idParam, body: exampleSchema }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const rules = await rulesFor(req.organization!._id);

    rules.examples.push(req.body);
    // only the most recent are sent to the model, so there is no point keeping
    // a hundred of them around. spliced in place, since assigning a plain array
    // would drop the subdocument methods the rest of the document relies on.
    if (rules.examples.length > 12) {
      rules.examples.splice(0, rules.examples.length - 12);
    }

    rules.updatedBy = new Types.ObjectId(req.userId);
    await rules.save();

    return created(res, rules.toJSON());
  }),
);

composerRouter.delete(
  "/:organizationId/rules/examples/:exampleId",
  validate({
    params: idParam.extend({ exampleId: z.string().refine(Types.ObjectId.isValid) }),
  }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const rules = await rulesFor(req.organization!._id);
    rules.examples.pull({ _id: req.params.exampleId });
    await rules.save();

    return ok(res, rules.toJSON());
  }),
);
