import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Testimonial } from "../models/Testimonial";
import { Update } from "../models/Update";
import { Reaction } from "../models/Reaction";
import { Bookmark } from "../models/Bookmark";
import { Repost } from "../models/Repost";
import { Comment } from "../models/Comment";
import { Follow } from "../models/Follow";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, created, page } from "../utils/respond";
import { badRequest, forbidden, notFound } from "../utils/errors";
import { notify, preview } from "../services/notify";
import { computeTestimonialScore } from "../services/ranking";
import { param } from "../utils/params";

export const testimonialsRouter = Router();

testimonialsRouter.use(requireAuth, requireOnboarded);

const idParam = z.object({ id: z.string().refine(Types.ObjectId.isValid, "not a valid id") });

const AUTHOR = "name username avatarSeed avatarStyle photoUrl avatarMode";
const QUOTED =
  "header body number category link publishedAt organization author attributed";

const createSchema = z.object({
  body: z.string().trim().min(20, "tell us a bit more than that").max(4000),
  /** the whole point: a testimonial always points back at an update */
  quotedUpdates: z
    .array(z.string().refine(Types.ObjectId.isValid))
    .min(1, "pick at least one update this is about")
    .max(4, "four updates is plenty"),
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
});

/** the viewer's own state across a page of testimonials, in two queries. */
async function viewerState(userId: string, ids: Types.ObjectId[]) {
  if (ids.length === 0) {
    return { celebrated: new Set<string>(), bookmarked: new Set<string>() };
  }

  const [reactions, bookmarks] = await Promise.all([
    Reaction.find({
      user: userId,
      subjectType: "testimonial",
      subject: { $in: ids },
      kind: "celebrate",
    })
      .select("subject")
      .lean(),
    Bookmark.find({ user: userId, subjectType: "testimonial", subject: { $in: ids } })
      .select("subject")
      .lean(),
  ]);

  return {
    celebrated: new Set(reactions.map((row) => String(row.subject))),
    bookmarked: new Set(bookmarks.map((row) => String(row.subject))),
  };
}

// ---------------------------------------------------------------------------
// the feed
// ---------------------------------------------------------------------------

/**
 * stories from people you know come first, but never only those. a feed of
 * five friends would go quiet in a week, so strangers with real engagement
 * stay mixed in.
 */
testimonialsRouter.get(
  "/",
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(40).default(20),
      cursor: z.string().optional(),
      filter: z.enum(["all", "connections"]).default("all"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      limit: number;
      cursor?: string;
      filter: "all" | "connections";
    };

    const follows = await Follow.find({ follower: req.userId, targetType: "user" })
      .select("target")
      .lean();
    const connections = follows.map((follow) => follow.target);

    const filter: Record<string, unknown> = { removedAt: null };

    if (query.filter === "connections") {
      if (connections.length === 0) return page(res, [], null);
      filter.author = { $in: connections };
    }

    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    // a wider pull than the page, so the connection weighting has room to work
    const candidates = await Testimonial.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit * 2)
      .populate("author", AUTHOR)
      .populate({
        path: "quotedUpdates",
        select: QUOTED,
        populate: [
          { path: "organization", select: "name handle logoUrl verifiedAt" },
          { path: "author", select: AUTHOR },
        ],
      })
      .lean();

    const connectionSet = new Set(connections.map(String));

    const ranked =
      query.filter === "connections"
        ? candidates
        : [...candidates].sort((a, b) => {
            const scoreOf = (item: (typeof candidates)[number]) =>
              computeTestimonialScore({
                celebrateCount: item.celebrateCount,
                commentCount: item.commentCount,
                repostCount: item.repostCount,
                publishedAt: item.publishedAt,
              }) * (connectionSet.has(String(item.author?._id ?? item.author)) ? 2.2 : 1);

            return scoreOf(b) - scoreOf(a);
          });

    const items = ranked.slice(0, query.limit);
    const viewer = await viewerState(
      req.userId!,
      items.map((item) => item._id),
    );

    const last = items[items.length - 1];

    return page(
      res,
      items.map((item) => ({
        ...item,
        viewer: {
          celebrated: viewer.celebrated.has(String(item._id)),
          bookmarked: viewer.bookmarked.has(String(item._id)),
        },
      })),
      candidates.length > query.limit && last ? String(last._id) : null,
    );
  }),
);

testimonialsRouter.get(
  "/:id",
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.findOne({ _id: param(req, "id"), removedAt: null })
      .populate("author", AUTHOR)
      .populate({
        path: "quotedUpdates",
        select: QUOTED,
        populate: [
          { path: "organization", select: "name handle logoUrl verifiedAt" },
          { path: "author", select: AUTHOR },
        ],
      })
      .lean();

    if (!testimonial) throw notFound("that testimonial is gone");

    const viewer = await viewerState(req.userId!, [testimonial._id]);

    return ok(res, {
      ...testimonial,
      viewer: {
        celebrated: viewer.celebrated.has(String(testimonial._id)),
        bookmarked: viewer.bookmarked.has(String(testimonial._id)),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// writing one
// ---------------------------------------------------------------------------

testimonialsRouter.post(
  "/",
  writeLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const { quotedUpdates, ...rest } = req.body;

    // every quoted update has to be real, or the story points nowhere
    const found = await Update.find({ _id: { $in: quotedUpdates }, removedAt: null })
      .select("_id author organization header")
      .lean();

    if (found.length !== quotedUpdates.length) {
      throw badRequest("one of those updates is gone");
    }

    const testimonial = await Testimonial.create({
      ...rest,
      author: req.userId,
      quotedUpdates,
      publishedAt: new Date(),
    });

    testimonial.rankScore = computeTestimonialScore(testimonial);
    await testimonial.save();

    // this is the loop closing: whoever posted the update hears what it did
    for (const update of found) {
      await Update.updateOne({ _id: update._id }, { $inc: { testimonialCount: 1 } });

      void notify({
        recipient: update.author,
        kind: "testimonial_quote",
        actor: req.userId,
        subjectType: "testimonial",
        subject: testimonial._id,
        preview: preview(rest.body),
        link: `/app/testimonials/${testimonial._id}`,
      });
    }

    const populated = await testimonial.populate([
      { path: "author", select: AUTHOR },
      {
        path: "quotedUpdates",
        select: QUOTED,
        populate: [
          { path: "organization", select: "name handle logoUrl verifiedAt" },
          { path: "author", select: AUTHOR },
        ],
      },
    ]);

    return created(res, populated.toJSON());
  }),
);

testimonialsRouter.delete(
  "/:id",
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.findById(param(req, "id"));
    if (!testimonial) throw notFound("that testimonial is gone");

    if (String(testimonial.author) !== req.userId) {
      throw forbidden("you can only delete your own testimonials");
    }

    testimonial.removedAt = new Date();
    await testimonial.save();

    await Update.updateMany(
      { _id: { $in: testimonial.quotedUpdates } },
      { $inc: { testimonialCount: -1 } },
    );

    return ok(res, { removed: true });
  }),
);

// ---------------------------------------------------------------------------
// reactions
// ---------------------------------------------------------------------------

testimonialsRouter.post(
  "/:id/celebrate",
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.findOne({ _id: param(req, "id"), removedAt: null });
    if (!testimonial) throw notFound("that testimonial is gone");

    try {
      await Reaction.create({
        user: req.userId,
        subjectType: "testimonial",
        subject: testimonial._id,
        kind: "celebrate",
      });
    } catch {
      return ok(res, { celebrated: true, celebrateCount: testimonial.celebrateCount });
    }

    testimonial.celebrateCount += 1;
    testimonial.rankScore = computeTestimonialScore(testimonial);
    await testimonial.save();

    void notify({
      recipient: testimonial.author,
      kind: "reaction",
      actor: req.userId,
      subjectType: "testimonial",
      subject: testimonial._id,
      preview: preview(testimonial.body),
      link: `/app/testimonials/${testimonial._id}`,
    });

    return ok(res, { celebrated: true, celebrateCount: testimonial.celebrateCount });
  }),
);

testimonialsRouter.delete(
  "/:id/celebrate",
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const removed = await Reaction.findOneAndDelete({
      user: req.userId,
      subjectType: "testimonial",
      subject: param(req, "id"),
      kind: "celebrate",
    });

    const testimonial = await Testimonial.findById(param(req, "id"));
    if (!testimonial) return ok(res, { celebrated: false, celebrateCount: 0 });

    if (removed) {
      testimonial.celebrateCount = Math.max(testimonial.celebrateCount - 1, 0);
      testimonial.rankScore = computeTestimonialScore(testimonial);
      await testimonial.save();
    }

    return ok(res, { celebrated: false, celebrateCount: testimonial.celebrateCount });
  }),
);

testimonialsRouter.post(
  "/:id/bookmark",
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    try {
      await Bookmark.create({
        user: req.userId,
        subjectType: "testimonial",
        subject: param(req, "id"),
      });
      await Testimonial.updateOne({ _id: param(req, "id") }, { $inc: { bookmarkCount: 1 } });
    } catch {
      // already saved, which is the state they wanted anyway
    }
    return ok(res, { bookmarked: true });
  }),
);

testimonialsRouter.delete(
  "/:id/bookmark",
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const removed = await Bookmark.findOneAndDelete({
      user: req.userId,
      subjectType: "testimonial",
      subject: param(req, "id"),
    });

    if (removed) {
      await Testimonial.updateOne({ _id: param(req, "id") }, { $inc: { bookmarkCount: -1 } });
    }
    return ok(res, { bookmarked: false });
  }),
);

testimonialsRouter.post(
  "/:id/repost",
  writeLimiter,
  validate({
    params: idParam,
    body: z.object({ body: z.string().trim().max(2000).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.findOne({ _id: param(req, "id"), removedAt: null });
    if (!testimonial) throw notFound("that testimonial is gone");

    try {
      await Repost.create({
        user: req.userId,
        subjectType: "testimonial",
        subject: testimonial._id,
        kind: req.body.body ? "quote" : "repost",
        body: req.body.body,
      });
    } catch {
      throw badRequest("you already reshared this one");
    }

    testimonial.repostCount += 1;
    testimonial.rankScore = computeTestimonialScore(testimonial);
    await testimonial.save();

    void notify({
      recipient: testimonial.author,
      kind: "repost",
      actor: req.userId,
      subjectType: "testimonial",
      subject: testimonial._id,
      preview: preview(testimonial.body),
      link: `/app/testimonials/${testimonial._id}`,
    });

    return created(res, { reposted: true });
  }),
);

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

testimonialsRouter.get(
  "/:id/comments",
  validate({
    params: idParam,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { limit: number; cursor?: string };

    const filter: Record<string, unknown> = {
      subjectType: "testimonial",
      subject: param(req, "id"),
      parent: null,
      removedAt: null,
    };
    if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };

    const comments = await Comment.find(filter)
      .sort({ createdAt: 1 })
      .limit(query.limit + 1)
      .populate("author", AUTHOR)
      .lean();

    const hasMore = comments.length > query.limit;
    const items = hasMore ? comments.slice(0, query.limit) : comments;
    const last = items[items.length - 1];

    return page(res, items, hasMore && last ? String(last._id) : null);
  }),
);

testimonialsRouter.post(
  "/:id/comments",
  writeLimiter,
  validate({
    params: idParam,
    body: z.object({ body: z.string().trim().min(1, "say something").max(2000) }),
  }),
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.findOne({ _id: param(req, "id"), removedAt: null });
    if (!testimonial) throw notFound("that testimonial is gone");

    const comment = await Comment.create({
      subjectType: "testimonial",
      subject: testimonial._id,
      author: req.userId,
      body: req.body.body,
    });

    testimonial.commentCount += 1;
    testimonial.rankScore = computeTestimonialScore(testimonial);
    await testimonial.save();

    void notify({
      recipient: testimonial.author,
      kind: "testimonial_comment",
      actor: req.userId,
      subjectType: "testimonial",
      subject: testimonial._id,
      preview: preview(req.body.body),
      link: `/app/testimonials/${testimonial._id}`,
    });

    return created(res, (await comment.populate("author", AUTHOR)).toJSON());
  }),
);
