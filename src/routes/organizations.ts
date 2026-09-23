import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { Organization } from "../models/Organization";
import { Membership } from "../models/Membership";
import { Invite } from "../models/Invite";
import { AiRuleSet } from "../models/AiRuleSet";
import { User } from "../models/User";
import { Follow } from "../models/Follow";
import { requireAuth, requireOnboarded } from "../middleware/auth";
import { requireRole } from "../middleware/membership";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { ok, created, page } from "../utils/respond";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors";
import { randomCode } from "../utils/random";
import { notify } from "../services/notify";
import { sendInviteEmail } from "../services/mail";
import { CATEGORIES, CHANNELS, ORG_ROLES, TIP_MODES } from "../types/domain";

export const organizationsRouter = Router();

organizationsRouter.use(requireAuth, requireOnboarded);

const RESERVED_HANDLES = [
  "app", "auth", "api", "admin", "onboarding", "settings", "terms",
  "privacy", "cookies", "discover", "feed", "me", "updatebase", "support",
];

const handleSchema = z
  .string()
  .trim()
  .min(3, "at least 3 characters")
  .max(30, "30 characters at most")
  .regex(/^[a-zA-Z0-9_]+$/, "letters, numbers and underscores only")
  .refine((value) => !RESERVED_HANDLES.includes(value.toLowerCase()), "that handle is reserved");

const createSchema = z.object({
  name: z.string().trim().min(2, "give it a name").max(60),
  handle: handleSchema,
  logoUrl: z.url().optional(),
  communityLink: z.url().optional(),
  categories: z.array(z.enum(CATEGORIES)).max(6).optional(),
});

const idParam = z.object({
  id: z.string().refine(Types.ObjectId.isValid, "not a valid id"),
});

// ---------------------------------------------------------------------------
// creating and reading
// ---------------------------------------------------------------------------

organizationsRouter.get(
  "/handle-available",
  validate({ query: z.object({ handle: handleSchema }) }),
  asyncHandler(async (req, res) => {
    const handle = String(req.query.handle);
    const taken = await Organization.exists({ handleLower: handle.toLowerCase() });
    return ok(res, { handle, available: !taken });
  }),
);

organizationsRouter.post(
  "/",
  writeLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const { handle, ...rest } = req.body;

    if (await Organization.exists({ handleLower: handle.toLowerCase() })) {
      throw conflict("that handle is already taken", { field: "handle" });
    }

    const organization = await Organization.create({
      ...rest,
      handle,
      handleLower: handle.toLowerCase(),
      createdBy: req.userId,
      connectedChannels: ["updatebase"],
    });

    // the creator owns it, and a rule set exists from day one so the composer
    // has something to read before anyone opens its settings
    await Promise.all([
      Membership.create({
        user: req.userId,
        organization: organization._id,
        role: "owner",
        channels: [...CHANNELS],
      }),
      AiRuleSet.create({ organization: organization._id, updatedBy: req.userId }),
      Follow.create({
        follower: req.userId,
        targetType: "organization",
        target: organization._id,
      }),
    ]);

    await Organization.updateOne({ _id: organization._id }, { $inc: { followerCount: 1 } });

    return created(res, organization.toJSON());
  }),
);

/** the organizations this person runs or posts for, for the profile switcher. */
organizationsRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const memberships = await Membership.find({ user: req.userId, removedAt: null })
      .sort({ createdAt: 1 })
      .populate("organization", "name handle logoUrl verifiedAt followerCount updateCount")
      .lean();

    return ok(
      res,
      memberships
        .filter((membership) => membership.organization)
        .map((membership) => ({
          organization: membership.organization,
          role: membership.role,
          channels: membership.channels,
        })),
    );
  }),
);

organizationsRouter.get(
  "/by-handle/:handle",
  validate({ params: z.object({ handle: z.string().min(1).max(30) }) }),
  asyncHandler(async (req, res) => {
    const organization = await Organization.findOne({
      handleLower: String(req.params.handle).toLowerCase(),
      suspendedAt: null,
    }).lean();

    if (!organization) throw notFound("we could not find that organization");

    const [membership, following] = await Promise.all([
      Membership.findOne({
        user: req.userId,
        organization: organization._id,
        removedAt: null,
      }).lean(),
      Follow.exists({
        follower: req.userId,
        targetType: "organization",
        target: organization._id,
      }),
    ]);

    return ok(res, {
      ...organization,
      viewer: {
        following: Boolean(following),
        role: membership?.role ?? null,
        channels: membership?.channels ?? [],
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  logoUrl: z.url().optional(),
  bannerUrl: z.url().optional(),
  bio: z.string().trim().max(600).optional(),
  tagline: z.string().trim().max(120).optional(),
  communityLink: z.url().optional(),
  website: z.url().optional(),
  categories: z.array(z.enum(CATEGORIES)).max(6).optional(),
  connectedChannels: z.array(z.enum(CHANNELS)).optional(),
  tipMode: z.enum(TIP_MODES).optional(),
  orgSharePercent: z.number().int().min(0).max(100).optional(),
});

organizationsRouter.patch(
  "/:id",
  writeLimiter,
  validate({ params: idParam, body: updateSchema }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;

    // only the owner decides where the money goes
    if (
      (req.body.tipMode !== undefined || req.body.orgSharePercent !== undefined) &&
      req.membership!.role !== "owner"
    ) {
      throw forbidden("only the owner can change how tips are split");
    }

    organization.set(req.body);
    await organization.save();

    return ok(res, organization.toJSON());
  }),
);

organizationsRouter.post(
  "/:id/transfer",
  writeLimiter,
  validate({
    params: idParam,
    body: z.object({ userId: z.string().refine(Types.ObjectId.isValid) }),
  }),
  requireRole("owner"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;
    const { userId } = req.body;

    if (userId === req.userId) throw badRequest("you already own this organization");

    const target = await Membership.findOne({
      user: userId,
      organization: organization._id,
      removedAt: null,
    });

    if (!target) throw badRequest("that person is not part of this organization yet");

    // the old owner stays on as an admin rather than losing access entirely
    await Promise.all([
      Membership.updateOne({ _id: target._id }, { $set: { role: "owner" } }),
      Membership.updateOne({ _id: req.membership!._id }, { $set: { role: "admin" } }),
      Organization.updateOne({ _id: organization._id }, { $set: { createdBy: userId } }),
    ]);

    void notify({
      recipient: userId,
      kind: "org_invite_accepted",
      actor: req.userId,
      actorOrganization: organization._id,
      subjectType: "organization",
      subject: organization._id,
      preview: `you now own ${organization.name}`,
      link: `/o/${organization.handle}`,
    });

    return ok(res, { transferred: true });
  }),
);

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

organizationsRouter.get(
  "/:id/members",
  validate({
    params: idParam,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  }),
  requireRole("delegate"),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { limit: number; cursor?: string };

    const filter: Record<string, unknown> = {
      organization: req.organization!._id,
      removedAt: null,
    };
    if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };

    const members = await Membership.find(filter)
      .sort({ _id: 1 })
      .limit(query.limit + 1)
      .populate("user", "name username avatarSeed avatarStyle photoUrl avatarMode email")
      .lean();

    const hasMore = members.length > query.limit;
    const items = hasMore ? members.slice(0, query.limit) : members;
    const last = items[items.length - 1];

    return page(res, items, hasMore && last ? String(last._id) : null);
  }),
);

organizationsRouter.patch(
  "/:id/members/:memberId",
  writeLimiter,
  validate({
    params: idParam.extend({ memberId: z.string().refine(Types.ObjectId.isValid) }),
    body: z.object({
      role: z.enum(ORG_ROLES).optional(),
      channels: z.array(z.enum(CHANNELS)).optional(),
    }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const membership = await Membership.findOne({
      _id: req.params.memberId,
      organization: req.organization!._id,
      removedAt: null,
    });

    if (!membership) throw notFound("that member is not in this organization");

    if (membership.role === "owner") {
      throw forbidden("the owner's role can only change through a transfer");
    }

    // an admin promoting someone to owner would be a transfer by the back door
    if (req.body.role === "owner") {
      throw forbidden("use transfer to hand over ownership");
    }

    if (req.body.role === "admin" && req.membership!.role !== "owner") {
      throw forbidden("only the owner can make someone an admin");
    }

    membership.set(req.body);
    await membership.save();

    return ok(res, membership.toJSON());
  }),
);

organizationsRouter.delete(
  "/:id/members/:memberId",
  validate({
    params: idParam.extend({ memberId: z.string().refine(Types.ObjectId.isValid) }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const membership = await Membership.findOne({
      _id: req.params.memberId,
      organization: req.organization!._id,
      removedAt: null,
    });

    if (!membership) throw notFound("that member is not in this organization");
    if (membership.role === "owner") throw forbidden("the owner cannot be removed");

    if (membership.role === "admin" && req.membership!.role !== "owner") {
      throw forbidden("only the owner can remove an admin");
    }

    membership.removedAt = new Date();
    await membership.save();
    await Organization.updateOne({ _id: req.organization!._id }, { $inc: { memberCount: -1 } });

    return ok(res, { removed: true });
  }),
);

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

const inviteSchema = z
  .object({
    role: z.enum(["admin", "delegate"]).default("delegate"),
    channels: z.array(z.enum(CHANNELS)).optional(),
    email: z.email().optional(),
    username: z.string().trim().min(3).max(24).optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    message: z.string().trim().max(400).optional(),
    /** true makes a link anyone can use rather than one addressed to a person */
    shareable: z.boolean().default(false),
  })
  .refine(
    (value) => value.shareable || value.email || value.username || value.phone,
    { message: "say who this is for, or make it a shareable link" },
  );

organizationsRouter.post(
  "/:id/invites",
  writeLimiter,
  validate({ params: idParam, body: inviteSchema }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const organization = req.organization!;
    const { shareable, username, email, ...rest } = req.body;

    if (rest.role === "admin" && req.membership!.role !== "owner") {
      throw forbidden("only the owner can invite an admin");
    }

    // if they are already here, resolve them so the invite lands in their app
    let invitee: Types.ObjectId | null = null;
    if (username || email) {
      const found = await User.findOne(
        username ? { usernameLower: username.toLowerCase() } : { email },
      )
        .select("_id")
        .lean();

      if (found) {
        const already = await Membership.exists({
          user: found._id,
          organization: organization._id,
          removedAt: null,
        });
        if (already) throw conflict("they are already part of this organization");

        invitee = found._id;
      }
    }

    const invite = await Invite.create({
      ...rest,
      email,
      username: username?.toLowerCase(),
      organization: organization._id,
      invitedBy: req.userId,
      invitee,
      code: randomCode(10),
      maxUses: shareable ? 500 : 1,
    });

    if (invitee) {
      void notify({
        recipient: invitee,
        kind: "org_invite",
        actor: req.userId,
        actorOrganization: organization._id,
        subjectType: "organization",
        subject: organization._id,
        preview: `${organization.name} invited you to post as a ${rest.role}`,
        link: `/invite/${invite.code}`,
      });
    } else if (email) {
      // not on updatebase yet, so email is the only way to reach them
      void sendInviteEmail({
        to: email,
        organizationName: organization.name,
        inviterName: req.user!.name ?? req.user!.username ?? "someone",
        role: rest.role,
        code: invite.code,
        message: rest.message,
      });
    }

    return created(res, invite.toJSON());
  }),
);

organizationsRouter.get(
  "/:id/invites",
  validate({ params: idParam }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const invites = await Invite.find({
      organization: req.organization!._id,
      acceptedAt: null,
      revokedAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("invitee", "name username avatarSeed photoUrl avatarMode")
      .lean();

    return ok(res, invites);
  }),
);

organizationsRouter.delete(
  "/:id/invites/:inviteId",
  validate({
    params: idParam.extend({ inviteId: z.string().refine(Types.ObjectId.isValid) }),
  }),
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await Invite.updateOne(
      { _id: req.params.inviteId, organization: req.organization!._id },
      { $set: { revokedAt: new Date() } },
    );
    return ok(res, { revoked: true });
  }),
);
