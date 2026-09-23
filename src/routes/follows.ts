import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Follow } from "../models/Follow";
import { User } from "../models/User";
import { Organization } from "../models/Organization";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, page } from "../utils/respond";
import { badRequest, notFound } from "../utils/errors";
import { notify } from "../services/notify";

export const followsRouter = Router();

followsRouter.use(requireAuth, requireOnboarded);

const targetSchema = z.object({
  targetType: z.enum(["user", "organization"]),
  target: z.string().refine(Types.ObjectId.isValid, "not a valid id"),
});

const USER_CARD = "name username avatarSeed avatarStyle photoUrl avatarMode bio followerCount";
const ORG_CARD = "name handle logoUrl bio tagline verifiedAt followerCount";

followsRouter.post(
  "/",
  writeLimiter,
  validate({ body: targetSchema }),
  asyncHandler(async (req, res) => {
    const { targetType, target } = req.body;

    if (targetType === "user" && target === req.userId) {
      throw badRequest("you cannot follow yourself");
    }

    const exists =
      targetType === "user"
        ? await User.exists({ _id: target, suspendedAt: null })
        : await Organization.exists({ _id: target, suspendedAt: null });

    if (!exists) throw notFound("we could not find that account");

    try {
      await Follow.create({ follower: req.userId, targetType, target });
    } catch {
      // the unique index means they already follow it, so nothing to do
      return ok(res, { following: true });
    }

    // following back makes it mutual, which is what weights the testimonial feed
    if (targetType === "user") {
      const reciprocal = await Follow.findOne({
        follower: target,
        targetType: "user",
        target: req.userId,
      });

      if (reciprocal) {
        await Promise.all([
          Follow.updateOne(
            { follower: req.userId, targetType: "user", target },
            { $set: { mutual: true } },
          ),
          Follow.updateOne({ _id: reciprocal._id }, { $set: { mutual: true } }),
        ]);
      }

      await Promise.all([
        User.updateOne({ _id: target }, { $inc: { followerCount: 1 } }),
        User.updateOne({ _id: req.userId }, { $inc: { followingCount: 1 } }),
      ]);

      void notify({
        recipient: target,
        kind: "follow",
        actor: req.userId,
        subjectType: "user",
        subject: req.userId,
        link: `/u/${req.user!.username}`,
      });
    } else {
      await Promise.all([
        Organization.updateOne({ _id: target }, { $inc: { followerCount: 1 } }),
        User.updateOne({ _id: req.userId }, { $inc: { followingCount: 1 } }),
      ]);
    }

    return ok(res, { following: true });
  }),
);

followsRouter.delete(
  "/",
  validate({ body: targetSchema }),
  asyncHandler(async (req, res) => {
    const { targetType, target } = req.body;

    const removed = await Follow.findOneAndDelete({
      follower: req.userId,
      targetType,
      target,
    });

    if (!removed) return ok(res, { following: false });

    if (targetType === "user") {
      await Promise.all([
        User.updateOne({ _id: target }, { $inc: { followerCount: -1 } }),
        User.updateOne({ _id: req.userId }, { $inc: { followingCount: -1 } }),
        // the other direction is no longer mutual either
        Follow.updateOne(
          { follower: target, targetType: "user", target: req.userId },
          { $set: { mutual: false } },
        ),
      ]);
    } else {
      await Promise.all([
        Organization.updateOne({ _id: target }, { $inc: { followerCount: -1 } }),
        User.updateOne({ _id: req.userId }, { $inc: { followingCount: -1 } }),
      ]);
    }

    return ok(res, { following: false });
  }),
);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().optional(),
  type: z.enum(["user", "organization", "all"]).default("all"),
});

/** everyone this person follows, for their profile and for the feed filters. */
followsRouter.get(
  "/following/:userId",
  validate({
    params: z.object({ userId: z.string().refine(Types.ObjectId.isValid) }),
    query: listQuerySchema,
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;

    const filter: Record<string, unknown> = { follower: req.params.userId };
    if (query.type !== "all") filter.targetType = query.type;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const follows = await Follow.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .lean();

    const hasMore = follows.length > query.limit;
    const items = hasMore ? follows.slice(0, query.limit) : follows;

    // resolve both kinds in two queries rather than one per row
    const userIds = items.filter((f) => f.targetType === "user").map((f) => f.target);
    const orgIds = items.filter((f) => f.targetType === "organization").map((f) => f.target);

    const [users, orgs] = await Promise.all([
      userIds.length ? User.find({ _id: { $in: userIds } }).select(USER_CARD).lean() : [],
      orgIds.length ? Organization.find({ _id: { $in: orgIds } }).select(ORG_CARD).lean() : [],
    ]);

    const byId = new Map<string, unknown>();
    for (const user of users) byId.set(String(user._id), { ...user, kind: "user" });
    for (const org of orgs) byId.set(String(org._id), { ...org, kind: "organization" });

    const last = items[items.length - 1];

    return page(
      res,
      items.map((follow) => byId.get(String(follow.target))).filter(Boolean),
      hasMore && last ? String(last._id) : null,
    );
  }),
);

/** who follows this account. */
followsRouter.get(
  "/followers/:targetType/:target",
  validate({
    params: z.object({
      targetType: z.enum(["user", "organization"]),
      target: z.string().refine(Types.ObjectId.isValid),
    }),
    query: listQuerySchema,
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;

    const filter: Record<string, unknown> = {
      targetType: req.params.targetType,
      target: req.params.target,
    };
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const follows = await Follow.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .populate("follower", USER_CARD)
      .lean();

    const hasMore = follows.length > query.limit;
    const items = hasMore ? follows.slice(0, query.limit) : follows;
    const last = items[items.length - 1];

    return page(
      res,
      items.map((follow) => follow.follower),
      hasMore && last ? String(last._id) : null,
    );
  }),
);
