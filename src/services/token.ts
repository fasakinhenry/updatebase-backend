import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env, isProduction } from "../config/env";
import { Session } from "../models/Session";
import { unauthorized } from "../utils/errors";

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

const REFRESH_COOKIE = "ub_refresh";

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
    issuer: "updatebase",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: "updatebase" }) as AccessTokenPayload;
  } catch {
    throw unauthorized("your session expired, please sign in again");
  }
}

/** the refresh token itself is random, the jwt secret only guards the access token. */
function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

/** we store the hash, never the token, so a dump of the table is useless. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(
  userId: string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<string> {
  const token = generateRefreshToken();

  await Session.create({
    user: userId,
    tokenHash: hashToken(token),
    userAgent: context.userAgent,
    ip: context.ip,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  return token;
}

/**
 * rotates a refresh token. if the presented token was already rotated out,
 * that means someone is replaying a stolen token, so every session for the
 * user is revoked rather than just this one.
 */
export async function rotateRefreshToken(
  token: string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<{ userId: string; refreshToken: string }> {
  const presentedHash = hashToken(token);
  const session = await Session.findOne({ tokenHash: presentedHash });

  if (!session) throw unauthorized("your session expired, please sign in again");

  if (session.revokedAt || session.replacedByHash) {
    await Session.updateMany(
      { user: session.user, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized("we signed you out everywhere because that session looked unsafe");
  }

  if (session.expiresAt.getTime() < Date.now()) {
    throw unauthorized("your session expired, please sign in again");
  }

  const nextToken = generateRefreshToken();
  const nextHash = hashToken(nextToken);

  session.replacedByHash = nextHash;
  session.revokedAt = new Date();
  await session.save();

  await Session.create({
    user: session.user,
    tokenHash: nextHash,
    userAgent: context.userAgent,
    ip: context.ip,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  return { userId: String(session.user), refreshToken: nextToken };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await Session.updateOne({ tokenHash: hashToken(token) }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    // the api and the site are on different hosts in production, so the cookie
    // has to be allowed cross site
    sameSite: isProduction ? "none" : "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    signed: true,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/",
  });
}

export function readRefreshCookie(signedCookies: Record<string, string>): string | null {
  return signedCookies[REFRESH_COOKIE] ?? null;
}
