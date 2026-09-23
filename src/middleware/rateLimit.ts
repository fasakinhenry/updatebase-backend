import rateLimit, { type Options } from "express-rate-limit";
import { tooManyRequests } from "../utils/errors";

function make(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(tooManyRequests()),
    ...options,
  });
}

/** the general ceiling, generous enough that normal use never sees it. */
export const generalLimiter = make({ windowMs: 15 * 60 * 1000, limit: 600 });

/** sign in and sign up, where guessing is the thing we are slowing down. */
export const authLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
});

/** ai calls cost quota, so they get their own much tighter budget. */
export const aiLimiter = make({ windowMs: 60 * 1000, limit: 12 });

/** anything that sends an email or a message to someone else. */
export const writeLimiter = make({ windowMs: 60 * 1000, limit: 40 });
