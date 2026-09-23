import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Update } from "../models/Update";
import { User } from "../models/User";
import { Organization } from "../models/Organization";
import { Testimonial } from "../models/Testimonial";
import { Follow } from "../models/Follow";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { aiLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok } from "../utils/respond";
import { parseQuery } from "../services/search";
import { loadViewerState, serializeUpdate } from "../services/feed";
import { CATEGORIES } from "../types/domain";

export const discoverRouter = Router();

discoverRouter.use(requireAuth, requireOnboarded);

const USER_CARD = "name username avatarSeed avatarStyle photoUrl avatarMode bio followerCount";
const ORG_CARD = "name handle logoUrl bio tagline verifiedAt followerCount updateCount categories";

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  q: z.string().trim().min(1, "type something to search for").max(200),
  /** narrows the results to one kind, overriding whatever the query implied */
  scope: z.enum(["all", "updates", "people", "organizations", "testimonials"]).default("all"),
  limit: z.coerce.number().int().min(1).max(40).default(20),
});

discoverRouter.get(
  "/search",
  aiLimiter,
  validate({ query: searchSchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof searchSchema>;
    const parsed = await parseQuery(query.q);

    // an explicit scope wins over anything we inferred from the wording
    const scope =
      query.scope !== "all"
        ? query.scope
        : parsed.intent === "people"
          ? "people"
          : parsed.intent === "organizations"
            ? "organizations"
            : "all";

    const text = parsed.keywords || query.q;

    const wantUpdates = scope === "all" || scope === "updates";
    const wantPeople = scope === "all" || scope === "people";
    const wantOrgs = scope === "all" || scope === "organizations";
    const wantTestimonials = scope === "all" || scope === "testimonials";

    const updateFilter: Record<string, unknown> = { removedAt: null };
    if (text) updateFilter.$text = { $search: text };
    if (parsed.categories.length > 0) updateFilter.category = { $in: parsed.categories };
    if (parsed.isRemote !== null) updateFilter.isRemote = parsed.isRemote;
    if (parsed.closingWithinDays !== null) {
      updateFilter.deadline = {
        $gte: new Date(),
        $lte: new Date(Date.now() + parsed.closingWithinDays * 24 * 60 * 60 * 1000),
      };
    }
    if (parsed.country) {
      // an update open to everyone lists no countries at all
      updateFilter.$or = [
        { eligibleCountries: parsed.country },
        { eligibleCountries: { $size: 0 } },
      ];
    }

    const [updates, people, organizations, testimonials] = await Promise.all([
      wantUpdates
        ? Update.find(updateFilter)
            .sort(text ? { score: { $meta: "textScore" } } : { rankScore: -1 })
            .limit(query.limit)
            .populate("organization", "name handle logoUrl verifiedAt followerCount")
            .populate("author", USER_CARD)
            .lean()
        : [],

      wantPeople && text
        ? User.find({ $text: { $search: text }, suspendedAt: null, profileVisibility: "public" })
            .sort({ score: { $meta: "textScore" } })
            .limit(query.limit)
            .select(USER_CARD)
            .lean()
        : [],

      wantOrgs && text
        ? Organization.find({ $text: { $search: text }, suspendedAt: null })
            .sort({ score: { $meta: "textScore" } })
            .limit(query.limit)
            .select(ORG_CARD)
            .lean()
        : [],

      wantTestimonials && text
        ? Testimonial.find({ $text: { $search: text }, removedAt: null })
            .sort({ score: { $meta: "textScore" } })
            .limit(query.limit)
            .populate("author", USER_CARD)
            .lean()
        : [],
    ]);

    const viewer = await loadViewerState(
      req.userId!,
      updates.map((update) => update._id),
    );

    return ok(res, {
      // echoed back so the ui can show what it understood, and let them undo it
      understood: parsed,
      updates: updates.map((update) => serializeUpdate(update as never, viewer)),
      people,
      organizations,
      testimonials,
    });
  }),
);

// ---------------------------------------------------------------------------
// suggestions
// ---------------------------------------------------------------------------

discoverRouter.get(
  "/suggestions",
  validate({
    query: z.object({
      type: z.enum(["mixed", "people", "organizations"]).default("mixed"),
      limit: z.coerce.number().int().min(1).max(30).default(12),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { type: string; limit: number };
    const user = req.user!;

    // never suggest something they already follow, or themselves
    const following = await Follow.find({ follower: req.userId }).select("target").lean();
    const excluded = [...following.map((follow) => follow.target), user._id];

    const wantOrgs = query.type === "mixed" || query.type === "organizations";
    const wantPeople = query.type === "mixed" || query.type === "people";
    const half = query.type === "mixed" ? Math.ceil(query.limit / 2) : query.limit;

    const [organizations, people] = await Promise.all([
      wantOrgs
        ? Organization.find({
            _id: { $nin: excluded },
            suspendedAt: null,
            // communities posting what they said they care about come first
            ...(user.interests?.length ? { categories: { $in: user.interests } } : {}),
          })
            .sort({ followerCount: -1, updateCount: -1 })
            .limit(half)
            .select(ORG_CARD)
            .lean()
        : [],

      wantPeople
        ? User.find({
            _id: { $nin: excluded },
            suspendedAt: null,
            profileVisibility: "public",
            bio: { $exists: true, $ne: "" },
            ...(user.interests?.length ? { interests: { $in: user.interests } } : {}),
          })
            .sort({ followerCount: -1 })
            .limit(half)
            .select(USER_CARD)
            .lean()
        : [],
    ]);

    return ok(res, {
      organizations: organizations.map((item) => ({ ...item, kind: "organization" as const })),
      people: people.map((item) => ({ ...item, kind: "user" as const })),
    });
  }),
);

// ---------------------------------------------------------------------------
// trending
// ---------------------------------------------------------------------------

discoverRouter.get(
  "/trending",
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [updates, topics] = await Promise.all([
      Update.find({ removedAt: null, publishedAt: { $gte: since } })
        .sort({ rankScore: -1 })
        .limit(10)
        .populate("organization", "name handle logoUrl verifiedAt")
        .populate("author", USER_CARD)
        .lean(),

      // the tags actually moving this week, not an all time list
      Update.aggregate<{ _id: string; count: number; engagement: number }>([
        { $match: { removedAt: null, publishedAt: { $gte: since } } },
        { $unwind: "$tags" },
        {
          $group: {
            _id: "$tags",
            count: { $sum: 1 },
            engagement: { $sum: { $add: ["$loveCount", "$bookmarkCount", "$commentCount"] } },
          },
        },
        { $sort: { engagement: -1, count: -1 } },
        { $limit: 12 },
      ]),
    ]);

    const viewer = await loadViewerState(
      req.userId!,
      updates.map((update) => update._id as Types.ObjectId),
    );

    return ok(res, {
      updates: updates.map((update) => serializeUpdate(update as never, viewer)),
      topics: topics.map((topic) => ({
        tag: topic._id,
        count: topic.count,
        engagement: topic.engagement,
      })),
      categories: CATEGORIES,
    });
  }),
);
