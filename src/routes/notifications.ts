import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Notification } from "../models/Notification";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/async";
import { ok, page } from "../utils/respond";
import { unreadCount } from "../services/notify";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth, requireOnboarded);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().optional(),
  /** "unread" is the filter people actually reach for */
  filter: z.enum(["all", "unread"]).default("all"),
});

notificationsRouter.get(
  "/",
  validate({ query: listSchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listSchema>;

    const filter: Record<string, unknown> = { recipient: req.userId };
    if (query.filter === "unread") filter.readAt = null;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const notifications = await Notification.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .populate("actor", "name username avatarSeed avatarStyle photoUrl avatarMode")
      .populate("actorOrganization", "name handle logoUrl verifiedAt")
      .lean();

    const hasMore = notifications.length > query.limit;
    const items = hasMore ? notifications.slice(0, query.limit) : notifications;
    const last = items[items.length - 1];

    return page(res, items, hasMore && last ? String(last._id) : null);
  }),
);

/** just the badge, kept cheap because it is polled. */
notificationsRouter.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    return ok(res, { count: await unreadCount(req.userId!) });
  }),
);

notificationsRouter.post(
  "/read",
  validate({
    body: z.object({
      /** omit to mark everything read */
      ids: z.array(z.string().refine(Types.ObjectId.isValid)).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { recipient: req.userId, readAt: null };
    if (req.body.ids?.length) filter._id = { $in: req.body.ids };

    await Notification.updateMany(filter, { $set: { readAt: new Date() } });

    return ok(res, { count: await unreadCount(req.userId!) });
  }),
);
