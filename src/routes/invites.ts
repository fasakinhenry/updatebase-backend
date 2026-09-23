import { Router } from "express";
import { z } from "zod";
import { Invite, type InviteDoc } from "../models/Invite";
import { Membership } from "../models/Membership";
import { Organization } from "../models/Organization";
import { Follow } from "../models/Follow";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok } from "../utils/respond";
import { badRequest, conflict, notFound } from "../utils/errors";
import { notify } from "../services/notify";

export const invitesRouter = Router();

const codeParam = z.object({ code: z.string().trim().min(4).max(64) });

/**
 * readable without an account, because the usual path is a link in an email
 * that lands on someone who has not signed up yet. they need to see what they
 * are being invited to before deciding whether to create an account.
 */
invitesRouter.get(
  "/:code",
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const invite = (await Invite.findOne({ code: req.params.code }).populate(
      "organization",
      "name handle logoUrl bio tagline followerCount memberCount verifiedAt",
    )) as InviteDoc | null;

    if (!invite) throw notFound("that invite link is not valid");

    return ok(res, {
      organization: invite.organization,
      role: invite.role,
      message: invite.message,
      usable: invite.isUsable(),
      expiresAt: invite.expiresAt,
      // says why it cannot be used, so the page can explain rather than just refuse
      reason: invite.revokedAt
        ? "revoked"
        : invite.acceptedAt
          ? "already_used"
          : invite.declinedAt
            ? "declined"
            : invite.expiresAt.getTime() < Date.now()
              ? "expired"
              : invite.useCount >= invite.maxUses
                ? "used_up"
                : null,
    });
  }),
);

invitesRouter.post(
  "/:code/accept",
  requireAuth,
  writeLimiter,
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const invite = (await Invite.findOne({ code: req.params.code })) as InviteDoc | null;

    if (!invite) throw notFound("that invite link is not valid");
    if (!invite.isUsable()) throw badRequest("that invite is no longer valid");

    // a targeted invite belongs to one person and nobody else
    if (invite.invitee && String(invite.invitee) !== req.userId) {
      throw badRequest("that invite was sent to someone else");
    }

    const already = await Membership.findOne({
      user: req.userId,
      organization: invite.organization,
      removedAt: null,
    });

    if (already) throw conflict("you are already part of this organization");

    await Membership.create({
      user: req.userId,
      organization: invite.organization,
      role: invite.role,
      channels: invite.channels,
      invitedBy: invite.invitedBy,
    });

    invite.useCount += 1;
    // a shareable link stays open, a targeted one is spent
    if (invite.useCount >= invite.maxUses) invite.acceptedAt = new Date();
    await invite.save();

    await Organization.updateOne({ _id: invite.organization }, { $inc: { memberCount: 1 } });

    // posting for a community without following it would be strange
    const following = await Follow.exists({
      follower: req.userId,
      targetType: "organization",
      target: invite.organization,
    });

    if (!following) {
      await Follow.create({
        follower: req.userId,
        targetType: "organization",
        target: invite.organization,
      });
      await Organization.updateOne({ _id: invite.organization }, { $inc: { followerCount: 1 } });
    }

    const organization = await Organization.findById(invite.organization)
      .select("name handle logoUrl")
      .lean();

    void notify({
      recipient: invite.invitedBy,
      kind: "org_invite_accepted",
      actor: req.userId,
      actorOrganization: invite.organization,
      subjectType: "organization",
      subject: invite.organization,
      preview: `${req.user!.username ?? "someone"} joined ${organization?.name ?? "your organization"}`,
      link: `/app/org/${organization?.handle}/dashboard`,
    });

    return ok(res, { organization, role: invite.role });
  }),
);

invitesRouter.post(
  "/:code/decline",
  requireAuth,
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const invite = await Invite.findOne({ code: req.params.code });
    if (!invite) throw notFound("that invite link is not valid");

    // declining a shareable link only means "not me", so it stays open
    if (invite.maxUses === 1) {
      invite.declinedAt = new Date();
      await invite.save();
    }

    return ok(res, { declined: true });
  }),
);
