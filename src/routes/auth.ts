import { Router, type Request, type Response } from "express";
import { randomSeed } from "../utils/random";
import { User, type UserDoc } from "../models/User";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, created } from "../utils/respond";
import { badRequest, unauthorized } from "../utils/errors";
import { hashPassword, verifyPassword } from "../services/password";
import { verifyGoogleCredential } from "../services/googleAuth";
import {
  clearRefreshCookie,
  issueRefreshToken,
  readRefreshCookie,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  setRefreshCookie,
  signAccessToken,
} from "../services/token";
import { googleSchema, loginSchema, registerSchema } from "../schemas/auth";

export const authRouter = Router();

type NextStep = "profile" | "conversation" | "location" | "app";

/** where this person should land, so the client never guesses. */
function nextStepFor(user: UserDoc): NextStep {
  if (!user.onboarding?.profileCompletedAt) return "profile";
  if (!user.onboarding?.conversationCompletedAt) return "conversation";
  if (!user.onboarding?.locationPromptedAt) return "location";
  return "app";
}

function sessionPayload(user: UserDoc, accessToken: string) {
  return { accessToken, user: user.toJSON(), nextStep: nextStepFor(user) };
}

/**
 * issues the pair: a short lived access token in the body and a rotating
 * refresh token in an httpOnly cookie the javascript never touches.
 */
async function startSession(user: UserDoc, req: Request, res: Response) {
  const accessToken = signAccessToken({ sub: String(user._id), email: user.email });
  const refreshToken = await issueRefreshToken(String(user._id), {
    userAgent: req.get("user-agent"),
    ip: req.ip,
  });
  setRefreshCookie(res, refreshToken);
  return sessionPayload(user, accessToken);
}

authRouter.post(
  "/register",
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const existing = await User.findOne({ email }).select("+passwordHash");

    if (existing) {
      // an account created through google has no password yet. rather than
      // refuse, we let them set one on the same account. this is the "no
      // hassles" part of using the same email for both sign in paths.
      if (!existing.passwordHash) {
        existing.passwordHash = await hashPassword(password);
        await existing.save();
        return ok(res, await startSession(existing, req, res));
      }

      throw badRequest("that email already has an account, try signing in instead");
    }

    const user = await User.create({
      email,
      passwordHash: await hashPassword(password),
      avatarSeed: randomSeed(),
    });

    return created(res, await startSession(user, req, res));
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+passwordHash");

    // the same message whether the email is unknown or the password is wrong,
    // so this cannot be used to find out which emails have accounts
    const invalid = unauthorized("that email and password do not match");
    if (!user) throw invalid;

    if (!user.passwordHash) {
      throw badRequest("this account uses google sign in. continue with google instead.");
    }

    if (!(await verifyPassword(password, user.passwordHash))) throw invalid;

    user.lastActiveAt = new Date();
    await user.save();

    return ok(res, await startSession(user, req, res));
  }),
);

authRouter.post(
  "/google",
  authLimiter,
  validate({ body: googleSchema }),
  asyncHandler(async (req, res) => {
    const profile = await verifyGoogleCredential(req.body.credential);

    if (!profile.emailVerified) {
      throw badRequest("google has not verified that email address");
    }

    // linking by verified email is what makes "I signed up with a password and
    // now I want google" work without producing a second account
    let user = await User.findOne({
      $or: [{ googleId: profile.googleId }, { email: profile.email }],
    });

    if (user) {
      if (!user.googleId) user.googleId = profile.googleId;
      if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();

      // only adopt the google photo when they have not chosen something already
      if (!user.photoUrl && profile.picture) {
        user.photoUrl = profile.picture;
        user.avatarMode = "photo";
      }
      if (!user.name && profile.name) user.name = profile.name;

      user.lastActiveAt = new Date();
      await user.save();
    } else {
      user = await User.create({
        email: profile.email,
        googleId: profile.googleId,
        emailVerifiedAt: new Date(),
        name: profile.name,
        photoUrl: profile.picture,
        avatarMode: profile.picture ? "photo" : "avatar",
        avatarSeed: randomSeed(),
      });
    }

    return ok(res, await startSession(user, req, res));
  }),
);

/** swaps the refresh cookie for a fresh access token and rotates the refresh token. */
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req.signedCookies ?? {});
    if (!presented) throw unauthorized("your session expired, please sign in again");

    const { userId, refreshToken } = await rotateRefreshToken(presented, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });

    const user = await User.findById(userId);
    if (!user) throw unauthorized("that account no longer exists");

    setRefreshCookie(res, refreshToken);
    const accessToken = signAccessToken({ sub: String(user._id), email: user.email });

    return ok(res, sessionPayload(user, accessToken));
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req.signedCookies ?? {});
    if (presented) await revokeRefreshToken(presented);
    clearRefreshCookie(res);
    return ok(res, { status: "signed out" });
  }),
);

authRouter.post(
  "/logout-everywhere",
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeAllSessions(req.userId!);
    clearRefreshCookie(res);
    return ok(res, { status: "signed out everywhere" });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const accessToken = signAccessToken({ sub: String(user._id), email: user.email });
    return ok(res, sessionPayload(user, accessToken));
  }),
);
