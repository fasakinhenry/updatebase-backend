import { Types } from "mongoose";
import { Update, type UpdateAttrs } from "../models/Update";
import { Follow } from "../models/Follow";
import { Reaction } from "../models/Reaction";
import { Bookmark } from "../models/Bookmark";
import { Repost } from "../models/Repost";
import type { UserDoc } from "../models/User";
import { personalMultiplier } from "./ranking";

export interface FeedOptions {
  limit: number;
  /** opaque cursor from the previous page */
  cursor?: string;
  category?: string;
}

type Lean = UpdateAttrs & { _id: Types.ObjectId };

/**
 * the viewer's own state for a set of updates, fetched in three queries rather
 * than one per card. without this a twenty item page would be sixty round trips.
 */
export interface ViewerState {
  loved: Set<string>;
  bookmarked: Set<string>;
  reposted: Set<string>;
}

export async function loadViewerState(
  userId: string,
  updateIds: Types.ObjectId[],
): Promise<ViewerState> {
  if (updateIds.length === 0) {
    return { loved: new Set(), bookmarked: new Set(), reposted: new Set() };
  }

  const [reactions, bookmarks, reposts] = await Promise.all([
    Reaction.find({ user: userId, subjectType: "update", subject: { $in: updateIds }, kind: "love" })
      .select("subject")
      .lean(),
    Bookmark.find({ user: userId, subjectType: "update", subject: { $in: updateIds } })
      .select("subject")
      .lean(),
    Repost.find({
      user: userId,
      subjectType: "update",
      subject: { $in: updateIds },
      kind: "repost",
    })
      .select("subject")
      .lean(),
  ]);

  return {
    loved: new Set(reactions.map((row) => String(row.subject))),
    bookmarked: new Set(bookmarks.map((row) => String(row.subject))),
    reposted: new Set(reposts.map((row) => String(row.subject))),
  };
}

/**
 * cursors encode the sort key plus the id, so a page boundary is stable even
 * when two updates share a score or a timestamp. an offset would skip or
 * repeat rows as new updates arrive mid scroll.
 */
function encodeCursor(value: number | Date, id: Types.ObjectId): string {
  const raw = value instanceof Date ? value.getTime() : value;
  return Buffer.from(`${raw}:${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { value: number; id: Types.ObjectId } | null {
  try {
    const [raw, id] = Buffer.from(cursor, "base64url").toString().split(":");
    if (!raw || !id) return null;
    return { value: Number(raw), id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}

/** the ids of every organization and person this user follows. */
async function followedTargets(userId: string) {
  const follows = await Follow.find({ follower: userId }).select("target targetType").lean();

  return {
    organizations: follows
      .filter((follow) => follow.targetType === "organization")
      .map((follow) => follow.target),
    users: follows.filter((follow) => follow.targetType === "user").map((follow) => follow.target),
  };
}

const AUTHOR_POPULATE = [
  { path: "organization", select: "name handle logoUrl verifiedAt followerCount" },
  { path: "author", select: "name username avatarSeed avatarStyle photoUrl avatarMode" },
] as const;

/**
 * following tab: strictly the organizations they chose, newest first. no
 * ranking at all, because the whole promise of this tab is that nothing is
 * hidden or reordered.
 */
export async function followingFeed(user: UserDoc, options: FeedOptions) {
  const { organizations } = await followedTargets(String(user._id));

  if (organizations.length === 0) {
    return { items: [] as Lean[], nextCursor: null };
  }

  const filter: Record<string, unknown> = {
    organization: { $in: organizations },
    removedAt: null,
  };

  if (options.category) filter.category = options.category;

  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (cursor) {
    filter.$or = [
      { publishedAt: { $lt: new Date(cursor.value) } },
      { publishedAt: new Date(cursor.value), _id: { $lt: cursor.id } },
    ];
  }

  const items = (await Update.find(filter)
    .sort({ publishedAt: -1, _id: -1 })
    .limit(options.limit + 1)
    .populate(AUTHOR_POPULATE as never)
    .lean()) as unknown as Lean[];

  const hasMore = items.length > options.limit;
  const page = hasMore ? items.slice(0, options.limit) : items;
  const last = page[page.length - 1];

  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(last.publishedAt, last._id) : null,
  };
}

/**
 * for you tab: their interests and the people they follow, reordered by a
 * personal multiplier applied over the stored score.
 *
 * we pull a wider candidate set than the page size, re-rank it in memory, then
 * slice. doing the personalisation in the database would need a per user index
 * that a free tier cannot carry.
 */
export async function forYouFeed(user: UserDoc, options: FeedOptions) {
  const { organizations } = await followedTargets(String(user._id));
  const interests = user.interests ?? [];

  const filter: Record<string, unknown> = { removedAt: null };

  if (options.category) {
    filter.category = options.category;
  } else if (interests.length > 0 || organizations.length > 0) {
    // things they said they care about, plus everything from who they follow
    const clauses: Record<string, unknown>[] = [];
    if (interests.length > 0) clauses.push({ category: { $in: interests } });
    if (organizations.length > 0) clauses.push({ organization: { $in: organizations } });
    filter.$or = clauses;
  }

  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (cursor) {
    filter.rankScore = { $lte: cursor.value };
    filter._id = { $ne: cursor.id };
  }

  // three pages of candidates gives the re-rank something to actually do
  const candidates = (await Update.find(filter)
    .sort({ rankScore: -1, publishedAt: -1 })
    .limit(options.limit * 3)
    .populate(AUTHOR_POPULATE as never)
    .lean()) as unknown as Lean[];

  const followed = new Set(organizations.map(String));
  const interested = new Set(interests as string[]);
  const country = user.location?.country;

  const ranked = candidates
    .map((update) => ({
      update,
      score:
        update.rankScore *
        personalMultiplier({
          matchesInterest: interested.has(update.category),
          isFollowed: followed.has(String(update.organization?._id ?? update.organization)),
          sameCountry: Boolean(
            country &&
              (update.eligibleCountries?.length === 0 ||
                update.eligibleCountries?.includes(country.slice(0, 2).toUpperCase())),
          ),
          isRemote: Boolean(update.isRemote),
          alreadySeen: false,
        }),
    }))
    .sort((a, b) => b.score - a.score);

  const page = ranked.slice(0, options.limit).map((entry) => entry.update);
  const last = page[page.length - 1];

  return {
    items: page,
    // the cursor stays on the stored score, so the next page picks up from the
    // same place in the database even though we reordered this one
    nextCursor:
      ranked.length > options.limit && last ? encodeCursor(last.rankScore, last._id) : null,
  };
}

/** what a single card needs, with the viewer's own state folded in. */
export function serializeUpdate(update: Lean, viewer: ViewerState) {
  const id = String(update._id);

  return {
    id,
    header: update.header,
    body: update.body,
    number: update.number,
    footer: update.footer,
    category: update.category,
    tags: update.tags,
    link: update.link,
    media: update.media,
    deadline: update.deadline,
    isRemote: update.isRemote,
    eligibleCountries: update.eligibleCountries,
    publishedAt: update.publishedAt,
    editedAt: update.editedAt,

    organization: update.organization,
    // an unattributed update hides its author, which is the org's choice
    author: update.attributed ? update.author : null,

    counts: {
      love: update.loveCount,
      comment: update.commentCount,
      repost: update.repostCount,
      quote: update.quoteCount,
      bookmark: update.bookmarkCount,
      testimonial: update.testimonialCount,
      tipTotal: update.tipTotal,
    },

    viewer: {
      loved: viewer.loved.has(id),
      bookmarked: viewer.bookmarked.has(id),
      reposted: viewer.reposted.has(id),
    },
  };
}
