import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../services/token";
import { User, type UserDoc } from "../models/User";
import { forbidden, unauthorized } from "../utils/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
      userId?: string;
    }
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** rejects the request unless a valid access token is present. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readBearer(req);
    if (!token) throw unauthorized();

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);

    if (!user) throw unauthorized("that account no longer exists");
    if (user.suspendedAt) throw forbidden("this account has been suspended");

    req.user = user;
    req.userId = String(user._id);
    next();
  } catch (error) {
    next(error);
  }
}

/** attaches the user when a token is present, but never rejects. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readBearer(req);
    if (!token) return next();

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);

    if (user && !user.suspendedAt) {
      req.user = user;
      req.userId = String(user._id);
    }
    next();
  } catch {
    // a bad token on an optional route is the same as no token at all
    next();
  }
}

/** for routes that only make sense once onboarding is behind the user. */
export function requireOnboarded(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) return next(unauthorized());

  if (!user.onboarding?.profileCompletedAt || !user.onboarding?.conversationCompletedAt) {
    return next(forbidden("finish setting up your profile first"));
  }
  next();
}
