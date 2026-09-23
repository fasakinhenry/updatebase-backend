import { Types } from "mongoose";
import { Notification } from "../models/Notification";
import { Follow } from "../models/Follow";
import { logger } from "../config/logger";
import type { NotificationKind } from "../types/domain";

type Id = Types.ObjectId | string;

interface NotifyInput {
  recipient: Id;
  kind: NotificationKind;
  actor?: Id | null;
  actorOrganization?: Id | null;
  recipientOrganization?: Id | null;
  subjectType?: "update" | "testimonial" | "comment" | "organization" | "user" | "wallet";
  subject?: Id;
  preview?: string;
  link?: string;
}

/** trims a body down to something that reads as a preview, not a truncation. */
export function preview(text: string, length = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  const cut = flat.slice(0, length);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : length)}...`;
}

/**
 * one notification. nothing here should ever fail the action that caused it,
 * so a failure is logged and swallowed. a missing notification is annoying, a
 * failed post is worse.
 */
export async function notify(input: NotifyInput): Promise<void> {
  // never tell someone about their own action
  if (input.actor && String(input.actor) === String(input.recipient)) return;

  try {
    await Notification.create(input);
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, "failed to create notification");
  }
}

/**
 * fans a notification out to everyone following a target.
 *
 * organizations can have a lot of followers, so this inserts in batches and
 * runs detached from the request. on a free tier that is the difference
 * between a post feeling instant and a post timing out.
 */
export async function notifyFollowers(
  target: Id,
  targetType: "user" | "organization",
  template: Omit<NotifyInput, "recipient">,
): Promise<void> {
  const BATCH = 500;

  try {
    let lastId: Types.ObjectId | null = null;

    for (;;) {
      const filter: Record<string, unknown> = { target, targetType };
      if (lastId) filter._id = { $gt: lastId };

      const followers = await Follow.find(filter)
        .sort({ _id: 1 })
        .limit(BATCH)
        .select("_id follower")
        .lean();

      if (followers.length === 0) break;

      await Notification.insertMany(
        followers
          .filter((follow) => String(follow.follower) !== String(template.actor ?? ""))
          .map((follow) => ({ ...template, recipient: follow.follower })),
        // one bad row should not drop the whole batch
        { ordered: false },
      );

      lastId = followers[followers.length - 1]!._id;
      if (followers.length < BATCH) break;
    }
  } catch (error) {
    logger.error({ err: error, target, targetType }, "failed to fan out notifications");
  }
}

/** how many unread notifications a person has, for the badge. */
export function unreadCount(userId: Id): Promise<number> {
  return Notification.countDocuments({ recipient: userId, readAt: null });
}
