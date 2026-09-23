import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Bookmark } from "../models/Bookmark";
import { Update } from "../models/Update";
import { Testimonial } from "../models/Testimonial";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/async";
import { page } from "../utils/respond";

export const bookmarksRouter = Router();

bookmarksRouter.use(requireAuth, requireOnboarded);

const AUTHOR = "name username avatarSeed avatarStyle photoUrl avatarMode";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().optional(),
  type: z.enum(["all", "update", "testimonial"]).default("all"),
  sort: z.enum(["latest", "oldest", "popular"]).default("latest"),
});

/**
 * everything saved, newest first by default, with the saved date carried
 * through so the client can group by month while scrolling.
 *
 * sorting by popularity has to happen after the documents are resolved, since
 * the counts live on the update rather than the bookmark row.
 */
bookmarksRouter.get(
  "/",
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof querySchema>;

    const filter: Record<string, unknown> = { user: req.userId };
    if (query.type !== "all") filter.subjectType = query.type;

    const ascending = query.sort === "oldest";

    if (query.cursor) {
      filter._id = ascending
        ? { $gt: new Types.ObjectId(query.cursor) }
        : { $lt: new Types.ObjectId(query.cursor) };
    }

    // popularity needs a wider pull, since the ordering is decided afterwards
    const take = query.sort === "popular" ? query.limit * 3 : query.limit + 1;

    const bookmarks = await Bookmark.find(filter)
      .sort({ _id: ascending ? 1 : -1 })
      .limit(take)
      .lean();

    if (bookmarks.length === 0) return page(res, [], null);

    const updateIds = bookmarks
      .filter((row) => row.subjectType === "update")
      .map((row) => row.subject);
    const testimonialIds = bookmarks
      .filter((row) => row.subjectType === "testimonial")
      .map((row) => row.subject);

    // two queries rather than one per row
    const [updates, testimonials] = await Promise.all([
      updateIds.length
        ? Update.find({ _id: { $in: updateIds }, removedAt: null })
            .populate("organization", "name handle logoUrl verifiedAt")
            .populate("author", AUTHOR)
            .lean()
        : [],
      testimonialIds.length
        ? Testimonial.find({ _id: { $in: testimonialIds }, removedAt: null })
            .populate("author", AUTHOR)
            .populate({
              path: "quotedUpdates",
              select: "header number category organization",
              populate: { path: "organization", select: "name handle logoUrl" },
            })
            .lean()
        : [],
    ]);

    const byId = new Map<string, Record<string, unknown>>();
    for (const update of updates) byId.set(String(update._id), update);
    for (const item of testimonials) byId.set(String(item._id), item);

    let items = bookmarks
      .map((row) => {
        const subject = byId.get(String(row.subject));
        // the underlying thing was deleted, so the bookmark has nothing to show
        if (!subject) return null;

        return {
          bookmarkId: String(row._id),
          bookmarkedAt: row.createdAt,
          note: row.note,
          type: row.subjectType,
          subject,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (query.sort === "popular") {
      items = items
        .sort((a, b) => {
          const weight = (entry: (typeof items)[number]) =>
            entry.type === "update"
              ? Number(entry.subject.loveCount ?? 0) +
                Number(entry.subject.bookmarkCount ?? 0) * 2
              : Number(entry.subject.celebrateCount ?? 0);

          return weight(b) - weight(a);
        })
        .slice(0, query.limit);
    }

    const hasMore = bookmarks.length > query.limit;
    const trimmed = query.sort === "popular" ? items : items.slice(0, query.limit);
    const lastRow = bookmarks[Math.min(query.limit, bookmarks.length) - 1];

    return page(
      res,
      trimmed,
      // popularity has no stable cursor, so it is a single ranked page
      hasMore && lastRow && query.sort !== "popular" ? String(lastRow._id) : null,
    );
  }),
);
