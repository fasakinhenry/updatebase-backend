import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { User, type UserDoc } from "../models/User";
import { Follow } from "../models/Follow";
import { Membership } from "../models/Membership";
import { Update } from "../models/Update";
import { Testimonial } from "../models/Testimonial";
import { Comment } from "../models/Comment";
import { Reaction } from "../models/Reaction";
import { Repost } from "../models/Repost";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, page } from "../utils/respond";
import { forbidden, notFound } from "../utils/errors";
import { loadViewerState, serializeUpdate } from "../services/feed";
import { CATEGORIES, VISIBILITY } from "../types/domain";

export const profilesRouter = Router();

profilesRouter.use(requireAuth, requireOnboarded);

const AUTHOR = "name username avatarSeed avatarStyle photoUrl avatarMode";

/**
 * decides whether one person may see another's profile.
 *
 * the rule that is easy to miss: a profile is always visible to the owner of
 * any organization the person posts for. someone representing your community
 * cannot hide from you.
 */
async function canView(viewerId: string, profile: UserDoc): Promise<boolean> {
  if (String(profile._id) === viewerId) return true;
  if (profile.profileVisibility === "public") return true;

  const theirOrgs = await Membership.find({ user: profile._id, removedAt: null })
    .select("organization")
    .lean();

  if (theirOrgs.length > 0) {
    const viewerOwns = await Membership.exists({
      user: viewerId,
      organization: { $in: theirOrgs.map((m) => m.organization) },
      role: "owner",
      removedAt: null,
    });
    if (viewerOwns) return true;
  }

  if (profile.profileVisibility === "private") return false;

  if (profile.profileVisibility === "followers") {
    return Boolean(
      await Follow.exists({
        follower: viewerId,
        targetType: "user",
        target: profile._id,
      }),
    );
  }

  if (profile.profileVisibility === "organizations") {
    // anyone in one of the same organizations can see it
    return Boolean(
      await Membership.exists({
        user: viewerId,
        organization: { $in: theirOrgs.map((m) => m.organization) },
        removedAt: null,
      }),
    );
  }

  return false;
}

profilesRouter.get(
  "/:username",
  validate({ params: z.object({ username: z.string().min(1).max(30) }) }),
  asyncHandler(async (req, res) => {
    const profile = await User.findOne({
      usernameLower: String(req.params.username).toLowerCase(),
      suspendedAt: null,
    });

    if (!profile) throw notFound("we could not find that person");

    if (!(await canView(req.userId!, profile))) {
      // says it exists but is private, rather than pretending it is not there
      throw forbidden("this profile is private");
    }

    const [memberships, following, counts] = await Promise.all([
      Membership.find({ user: profile._id, removedAt: null })
        .populate("organization", "name handle logoUrl verifiedAt followerCount")
        .lean(),
      Follow.exists({ follower: req.userId, targetType: "user", target: profile._id }),
      Promise.all([
        Testimonial.countDocuments({ author: profile._id, removedAt: null }),
        Update.countDocuments({ author: profile._id, removedAt: null }),
      ]),
    ]);

    return ok(res, {
      ...profile.toJSON(),
      organizations: memberships
        .filter((membership) => membership.organization)
        .map((membership) => ({
          organization: membership.organization,
          role: membership.role,
        })),
      counts: { testimonials: counts[0], updates: counts[1] },
      viewer: {
        following: Boolean(following),
        isSelf: String(profile._id) === req.userId,
      },
    });
  }),
);

/**
 * the activity tabs. all of them live behind one route because they share the
 * same visibility check, and duplicating that check five times is how it ends
 * up wrong in one of them.
 */
profilesRouter.get(
  "/:username/activity",
  validate({
    params: z.object({ username: z.string().min(1).max(30) }),
    query: z.object({
      tab: z
        .enum(["updates", "testimonials", "comments", "likes", "reshares", "gallery"])
        .default("updates"),
      limit: z.coerce.number().int().min(1).max(40).default(20),
      cursor: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { tab: string; limit: number; cursor?: string };

    const profile = await User.findOne({
      usernameLower: String(req.params.username).toLowerCase(),
      suspendedAt: null,
    });

    if (!profile) throw notFound("we could not find that person");
    if (!(await canView(req.userId!, profile))) throw forbidden("this profile is private");

    const cursorFilter = query.cursor ? { _id: { $lt: new Types.ObjectId(query.cursor) } } : {};
    const take = query.limit + 1;

    const finish = <T extends { _id: Types.ObjectId }>(rows: T[]) => {
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      return page(res, items, hasMore && last ? String(last._id) : null);
    };

    switch (query.tab) {
      case "updates": {
        const updates = await Update.find({
          author: profile._id,
          attributed: true,
          removedAt: null,
          ...cursorFilter,
        })
          .sort({ _id: -1 })
          .limit(take)
          .populate("organization", "name handle logoUrl verifiedAt")
          .populate("author", AUTHOR)
          .lean();

        const viewer = await loadViewerState(
          req.userId!,
          updates.map((update) => update._id),
        );

        const hasMore = updates.length > query.limit;
        const items = hasMore ? updates.slice(0, query.limit) : updates;
        const last = items[items.length - 1];

        return page(
          res,
          items.map((update) => serializeUpdate(update as never, viewer)),
          hasMore && last ? String(last._id) : null,
        );
      }

      case "testimonials": {
        return finish(
          await Testimonial.find({ author: profile._id, removedAt: null, ...cursorFilter })
            .sort({ _id: -1 })
            .limit(take)
            .populate("author", AUTHOR)
            .populate({
              path: "quotedUpdates",
              select: "header number category organization",
              populate: { path: "organization", select: "name handle logoUrl" },
            })
            .lean(),
        );
      }

      case "comments": {
        return finish(
          await Comment.find({ author: profile._id, removedAt: null, ...cursorFilter })
            .sort({ _id: -1 })
            .limit(take)
            .populate("author", AUTHOR)
            .lean(),
        );
      }

      case "likes": {
        return finish(
          await Reaction.find({ user: profile._id, kind: "love", ...cursorFilter })
            .sort({ _id: -1 })
            .limit(take)
            .lean(),
        );
      }

      case "reshares": {
        return finish(
          await Repost.find({ user: profile._id, removedAt: null, ...cursorFilter })
            .sort({ _id: -1 })
            .limit(take)
            .lean(),
        );
      }

      case "gallery": {
        // everything they posted that carries media, updates and testimonials alike
        const [updates, testimonials] = await Promise.all([
          Update.find({
            author: profile._id,
            attributed: true,
            removedAt: null,
            "media.0": { $exists: true },
          })
            .sort({ _id: -1 })
            .limit(take)
            .select("media header publishedAt")
            .lean(),
          Testimonial.find({
            author: profile._id,
            removedAt: null,
            "media.0": { $exists: true },
          })
            .sort({ _id: -1 })
            .limit(take)
            .select("media body publishedAt")
            .lean(),
        ]);

        const combined = [
          ...updates.map((item) => ({ ...item, type: "update" as const })),
          ...testimonials.map((item) => ({ ...item, type: "testimonial" as const })),
        ]
          .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
          .slice(0, query.limit);

        return page(res, combined, null);
      }

      default:
        return page(res, [], null);
    }
  }),
);

// ---------------------------------------------------------------------------
// editing your own
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(600).optional(),
  photoUrl: z.url().optional(),
  bannerUrl: z.url().optional(),
  avatarSeed: z.string().max(64).optional(),
  avatarStyle: z.string().max(40).optional(),
  avatarMode: z.enum(["avatar", "photo"]).optional(),
  interests: z.array(z.enum(CATEGORIES)).max(13).optional(),
  school: z.string().trim().max(120).optional(),
  company: z.string().trim().max(120).optional(),
  profession: z.string().trim().max(120).optional(),
  profileVisibility: z.enum(VISIBILITY).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  /** pause incoming dms until this moment. null lifts it. */
  dmsPausedUntil: z.iso.datetime().nullable().optional(),
});

profilesRouter.patch(
  "/me",
  writeLimiter,
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { dmsPausedUntil, ...rest } = req.body;

    user.set(rest);
    if (dmsPausedUntil !== undefined) {
      user.dmsPausedUntil = dmsPausedUntil ? new Date(dmsPausedUntil) : null;
    }

    await user.save();
    return ok(res, user.toJSON());
  }),
);
