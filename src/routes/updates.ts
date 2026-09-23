import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Update } from "../models/Update";
import { Reaction } from "../models/Reaction";
import { Bookmark } from "../models/Bookmark";
import { Repost } from "../models/Repost";
import { Comment } from "../models/Comment";
import { User } from "../models/User";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, created, page } from "../utils/respond";
import { badRequest, notFound } from "../utils/errors";
import { notify, preview } from "../services/notify";
import { computeUpdateScore } from "../services/ranking";
import { loadViewerState, serializeUpdate } from "../services/feed";
import { param } from "../utils/params";

export const updatesRouter = Router();

updatesRouter.use(requireAuth, requireOnboarded);

const idSchema = z.object({ id: z.string().refine(Types.ObjectId.isValid, "not a valid id") });

/**
 * counters live on the update so a feed page needs no aggregation. every write
 * that moves one also refreshes the stored rank score, which is what keeps the
 * for you feed a single indexed read.
 */
async function bumpCounters(updateId: string, changes: Record<string, number>) {
  const update = await Update.findByIdAndUpdate(updateId, { $inc: changes }, { new: true });
  if (!update) return null;

  update.rankScore = computeUpdateScore(update);
  await update.save();
  return update;
}

updatesRouter.get(
  "/:id",
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const update = await Update.findOne({ _id: param(req, "id"), removedAt: null })
      .populate("organization", "name handle logoUrl verifiedAt followerCount")
      .populate("author", "name username avatarSeed avatarStyle photoUrl avatarMode")
      .lean();

    if (!update) throw notFound("that update is gone");

    // a view is worth counting but never worth making someone wait for
    void Update.updateOne({ _id: param(req, "id") }, { $inc: { viewCount: 1 } }).exec();

    const viewer = await loadViewerState(req.userId!, [update._id]);
    return ok(res, serializeUpdate(update as never, viewer));
  }),
);

// ---------------------------------------------------------------------------
// love
// ---------------------------------------------------------------------------

updatesRouter.post(
  "/:id/love",
  writeLimiter,
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const update = await Update.findOne({ _id: param(req, "id"), removedAt: null });
    if (!update) throw notFound("that update is gone");

    try {
      await Reaction.create({
        user: req.userId,
        subjectType: "update",
        subject: update._id,
        kind: "love",
      });
    } catch {
      // the unique index means a double tap is already loved, which is fine
      return ok(res, { loved: true, loveCount: update.loveCount });
    }

    const updated = await bumpCounters(String(update._id), { loveCount: 1 });

    void notify({
      recipient: update.author,
      kind: "reaction",
      actor: req.userId,
      subjectType: "update",
      subject: update._id,
      preview: preview(update.header),
      link: `/app/updates/${update._id}`,
    });

    return ok(res, { loved: true, loveCount: updated?.loveCount ?? update.loveCount + 1 });
  }),
);

updatesRouter.delete(
  "/:id/love",
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const removed = await Reaction.findOneAndDelete({
      user: req.userId,
      subjectType: "update",
      subject: param(req, "id"),
      kind: "love",
    });

    if (!removed) {
      const current = await Update.findById(param(req, "id")).select("loveCount").lean();
      return ok(res, { loved: false, loveCount: current?.loveCount ?? 0 });
    }

    const updated = await bumpCounters(param(req, "id"), { loveCount: -1 });
    return ok(res, { loved: false, loveCount: Math.max(updated?.loveCount ?? 0, 0) });
  }),
);

// ---------------------------------------------------------------------------
// bookmarks
// ---------------------------------------------------------------------------

updatesRouter.post(
  "/:id/bookmark",
  writeLimiter,
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const update = await Update.findOne({ _id: param(req, "id"), removedAt: null }).select("_id");
    if (!update) throw notFound("that update is gone");

    try {
      await Bookmark.create({ user: req.userId, subjectType: "update", subject: update._id });
    } catch {
      return ok(res, { bookmarked: true });
    }

    await bumpCounters(String(update._id), { bookmarkCount: 1 });
    return ok(res, { bookmarked: true });
  }),
);

updatesRouter.delete(
  "/:id/bookmark",
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const removed = await Bookmark.findOneAndDelete({
      user: req.userId,
      subjectType: "update",
      subject: param(req, "id"),
    });

    if (removed) await bumpCounters(param(req, "id"), { bookmarkCount: -1 });
    return ok(res, { bookmarked: false });
  }),
);

// ---------------------------------------------------------------------------
// reposts and quotes
// ---------------------------------------------------------------------------

const quoteSchema = z.object({
  body: z.string().trim().min(1, "say something").max(2000).optional(),
});

updatesRouter.post(
  "/:id/repost",
  writeLimiter,
  validate({ params: idSchema, body: quoteSchema }),
  asyncHandler(async (req, res) => {
    const update = await Update.findOne({ _id: param(req, "id"), removedAt: null });
    if (!update) throw notFound("that update is gone");

    const isQuote = Boolean(req.body.body);

    try {
      await Repost.create({
        user: req.userId,
        subjectType: "update",
        subject: update._id,
        kind: isQuote ? "quote" : "repost",
        body: req.body.body,
      });
    } catch {
      throw badRequest("you already reshared this one");
    }

    await bumpCounters(String(update._id), isQuote ? { quoteCount: 1 } : { repostCount: 1 });

    void notify({
      recipient: update.author,
      kind: isQuote ? "quote" : "repost",
      actor: req.userId,
      subjectType: "update",
      subject: update._id,
      preview: preview(req.body.body ?? update.header),
      link: `/app/updates/${update._id}`,
    });

    return created(res, { reposted: true });
  }),
);

updatesRouter.delete(
  "/:id/repost",
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const removed = await Repost.findOneAndDelete({
      user: req.userId,
      subjectType: "update",
      subject: param(req, "id"),
      kind: "repost",
    });

    if (removed) await bumpCounters(param(req, "id"), { repostCount: -1 });
    return ok(res, { reposted: false });
  }),
);

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

const commentSchema = z.object({
  body: z.string().trim().min(1, "say something").max(2000),
  parent: z.string().refine(Types.ObjectId.isValid).optional(),
  /** post as an organization you belong to, rather than as yourself */
  asOrganization: z.string().refine(Types.ObjectId.isValid).optional(),
});

/** pulls @names out of a comment and resolves them to real accounts. */
async function resolveMentions(body: string): Promise<Types.ObjectId[]> {
  const handles = [...body.matchAll(/@([a-zA-Z0-9_]{3,24})/g)].map((match) =>
    match[1]!.toLowerCase(),
  );

  if (handles.length === 0) return [];

  const users = await User.find({ usernameLower: { $in: [...new Set(handles)] } })
    .select("_id")
    .lean();

  return users.map((user) => user._id);
}

updatesRouter.get(
  "/:id/comments",
  validate({
    params: idSchema,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().optional(),
      /** omit for top level, pass a comment id to read one thread */
      parent: z.string().refine(Types.ObjectId.isValid).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { limit: number; cursor?: string; parent?: string };

    const filter: Record<string, unknown> = {
      subjectType: "update",
      subject: param(req, "id"),
      parent: query.parent ?? null,
      removedAt: null,
    };

    if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };

    const comments = await Comment.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(query.limit + 1)
      .populate("author", "name username avatarSeed avatarStyle photoUrl avatarMode")
      .populate("asOrganization", "name handle logoUrl verifiedAt")
      .lean();

    const hasMore = comments.length > query.limit;
    const items = hasMore ? comments.slice(0, query.limit) : comments;
    const last = items[items.length - 1];

    return page(res, items, hasMore && last ? String(last._id) : null);
  }),
);

updatesRouter.post(
  "/:id/comments",
  writeLimiter,
  validate({ params: idSchema, body: commentSchema }),
  asyncHandler(async (req, res) => {
    const update = await Update.findOne({ _id: param(req, "id"), removedAt: null });
    if (!update) throw notFound("that update is gone");

    let depth = 0;
    let thread: Types.ObjectId | null = null;

    if (req.body.parent) {
      const parent = await Comment.findById(req.body.parent);
      if (!parent) throw notFound("that comment is gone");

      // four levels is enough for a conversation, past that it is unreadable
      depth = Math.min(parent.depth + 1, 4);
      thread = parent.thread ?? parent._id;
    }

    const mentions = await resolveMentions(req.body.body);

    const comment = await Comment.create({
      subjectType: "update",
      subject: update._id,
      author: req.userId,
      asOrganization: req.body.asOrganization ?? null,
      body: req.body.body,
      parent: req.body.parent ?? null,
      thread,
      depth,
      mentions,
    });

    await bumpCounters(String(update._id), { commentCount: 1 });

    if (req.body.parent) {
      await Comment.updateOne({ _id: req.body.parent }, { $inc: { replyCount: 1 } });

      const parent = await Comment.findById(req.body.parent).select("author").lean();
      if (parent) {
        void notify({
          recipient: parent.author,
          kind: "comment_reply",
          actor: req.userId,
          subjectType: "comment",
          subject: comment._id,
          preview: preview(req.body.body),
          link: `/app/updates/${update._id}`,
        });
      }
    } else {
      void notify({
        recipient: update.author,
        kind: "comment",
        actor: req.userId,
        subjectType: "update",
        subject: update._id,
        preview: preview(req.body.body),
        link: `/app/updates/${update._id}`,
      });
    }

    // being named should reach you even if you never open the app
    for (const mentioned of mentions) {
      void notify({
        recipient: mentioned,
        kind: "mention",
        actor: req.userId,
        subjectType: "comment",
        subject: comment._id,
        preview: preview(req.body.body),
        link: `/app/updates/${update._id}`,
      });
    }

    const populated = await comment.populate([
      { path: "author", select: "name username avatarSeed avatarStyle photoUrl avatarMode" },
      { path: "asOrganization", select: "name handle logoUrl verifiedAt" },
    ]);

    return created(res, populated.toJSON());
  }),
);

updatesRouter.delete(
  "/comments/:id",
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const comment = await Comment.findById(param(req, "id"));
    if (!comment) throw notFound("that comment is gone");

    if (String(comment.author) !== req.userId) {
      throw badRequest("you can only delete your own comments");
    }

    comment.removedAt = new Date();
    await comment.save();

    await bumpCounters(String(comment.subject), { commentCount: -1 });
    if (comment.parent) {
      await Comment.updateOne({ _id: comment.parent }, { $inc: { replyCount: -1 } });
    }

    return ok(res, { removed: true });
  }),
);
