import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CHANNELS, ORG_ROLES } from "../types/domain";

/**
 * an invite to join an organization.
 *
 * it can name a person four ways: an email, a username, a phone number, or
 * nobody at all, which makes it a shareable link anyone can click.
 */
const inviteSchema = new Schema(
  {
    organization: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    role: { type: String, enum: ORG_ROLES, default: "delegate" },
    channels: [{ type: String, enum: CHANNELS }],

    /** how the invite was addressed. all optional, a link invite has none. */
    email: { type: String, lowercase: true, trim: true, index: true },
    username: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    /** resolved once we know which account it belongs to */
    invitee: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },

    /** the code in the url. unguessable. */
    code: { type: String, required: true, unique: true, index: true },
    /** a link invite can be used many times, a targeted one exactly once */
    maxUses: { type: Number, default: 1, min: 1 },
    useCount: { type: Number, default: 0, min: 0 },

    message: { type: String, maxlength: 400 },

    acceptedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

inviteSchema.index({ organization: 1, createdAt: -1 });
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** an invite is only usable while it is unspent, unrevoked and unexpired. */
inviteSchema.methods.isUsable = function (): boolean {
  return (
    !this.acceptedAt &&
    !this.declinedAt &&
    !this.revokedAt &&
    this.useCount < this.maxUses &&
    this.expiresAt.getTime() > Date.now()
  );
};

export type InviteAttrs = InferSchemaType<typeof inviteSchema>;
export type InviteDoc = HydratedDocument<InviteAttrs> & { isUsable(): boolean };

export const Invite = model("Invite", inviteSchema);
