import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/async";
import { page } from "../utils/respond";
import { CATEGORIES } from "../types/domain";
import { followingFeed, forYouFeed, loadViewerState, serializeUpdate } from "../services/feed";

export const feedRouter = Router();

feedRouter.use(requireAuth, requireOnboarded);

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(40).default(20),
  cursor: z.string().max(200).optional(),
  category: z.enum(CATEGORIES).optional(),
});

/**
 * both tabs return the identical update shape. that is deliberate: one card
 * component renders either, so nothing can drift between them.
 */
for (const [path, load] of [
  ["/for-you", forYouFeed],
  ["/following", followingFeed],
] as const) {
  feedRouter.get(
    path,
    validate({ query: feedQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as z.infer<typeof feedQuerySchema>;

      const { items, nextCursor } = await load(req.user!, {
        limit: query.limit,
        cursor: query.cursor,
        category: query.category,
      });

      const viewer = await loadViewerState(
        req.userId!,
        items.map((item) => item._id as Types.ObjectId),
      );

      return page(
        res,
        items.map((item) => serializeUpdate(item, viewer)),
        nextCursor,
      );
    }),
  );
}
