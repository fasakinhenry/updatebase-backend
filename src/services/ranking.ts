import type { UpdateDoc } from "../models/Update";

/**
 * how an update scores in the for you feed.
 *
 * the shape is deliberately boring: engagement decayed by age, plus a few
 * bonuses for things that actually matter to someone hunting opportunities.
 * it is stored on the document and recomputed on write, so reading a ranked
 * page stays one indexed query instead of a scan and a sort.
 */

const HALF_LIFE_HOURS = 30;

/** weights chosen so a save counts for more than a like, because it means more. */
const WEIGHTS = {
  love: 1,
  comment: 2.5,
  repost: 3,
  quote: 3.5,
  bookmark: 4,
  testimonial: 12,
  tip: 6,
} as const;

function hoursSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

export function computeUpdateScore(update: {
  loveCount: number;
  commentCount: number;
  repostCount: number;
  quoteCount: number;
  bookmarkCount: number;
  testimonialCount: number;
  tipTotal: number;
  publishedAt: Date;
  deadline?: Date | null;
}): number {
  const engagement =
    update.loveCount * WEIGHTS.love +
    update.commentCount * WEIGHTS.comment +
    update.repostCount * WEIGHTS.repost +
    update.quoteCount * WEIGHTS.quote +
    update.bookmarkCount * WEIGHTS.bookmark +
    update.testimonialCount * WEIGHTS.testimonial +
    (update.tipTotal > 0 ? WEIGHTS.tip : 0);

  const age = hoursSince(update.publishedAt);
  const decay = Math.pow(0.5, age / HALF_LIFE_HOURS);

  // the log keeps one viral update from burying everything else for a week
  let score = Math.log1p(engagement) * 10 * decay;

  // a new post needs a floor, or nothing would ever get its first look
  score += 5 * decay;

  if (update.deadline) {
    const hoursLeft = -hoursSince(update.deadline);

    // already closed, so it is only history now
    if (hoursLeft < 0) {
      score *= 0.1;
    } else if (hoursLeft < 72) {
      // closing within three days is the most useful thing we can surface
      score *= 1.6;
    } else if (hoursLeft < 168) {
      score *= 1.2;
    }
  }

  return Math.round(score * 1000) / 1000;
}

export function applyUpdateScore(update: UpdateDoc): void {
  update.rankScore = computeUpdateScore({
    loveCount: update.loveCount,
    commentCount: update.commentCount,
    repostCount: update.repostCount,
    quoteCount: update.quoteCount,
    bookmarkCount: update.bookmarkCount,
    testimonialCount: update.testimonialCount,
    tipTotal: update.tipTotal,
    publishedAt: update.publishedAt,
    deadline: update.deadline,
  });
}

/**
 * the personal part of the for you feed, applied after the database has
 * narrowed the candidates. it is a multiplier rather than a stored value,
 * because it differs for every reader.
 */
export function personalMultiplier(options: {
  matchesInterest: boolean;
  isFollowed: boolean;
  sameCountry: boolean;
  isRemote: boolean;
  alreadySeen: boolean;
}): number {
  let multiplier = 1;

  if (options.matchesInterest) multiplier *= 1.8;
  if (options.isFollowed) multiplier *= 1.5;
  // a country match matters, unless the thing is remote and open to anyone
  if (options.sameCountry) multiplier *= 1.3;
  else if (options.isRemote) multiplier *= 1.1;

  // seen it already, so push it down without hiding it outright
  if (options.alreadySeen) multiplier *= 0.35;

  return multiplier;
}

/**
 * testimonials lean on closeness rather than freshness. someone you actually
 * know getting a scholarship is worth more than a stranger going viral.
 */
export function computeTestimonialScore(testimonial: {
  celebrateCount: number;
  commentCount: number;
  repostCount: number;
  publishedAt: Date;
}): number {
  const engagement =
    testimonial.celebrateCount + testimonial.commentCount * 2 + testimonial.repostCount * 3;

  // a longer half life, because a good story stays worth reading
  const decay = Math.pow(0.5, hoursSince(testimonial.publishedAt) / 96);

  return Math.round((Math.log1p(engagement) * 10 + 4) * decay * 1000) / 1000;
}
