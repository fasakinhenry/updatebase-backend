import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CHANNELS, ORG_ROLES } from "../types/domain";

/**
 * joins a user to an organization with a role. a user can belong to many
 * organizations and acts in one at a time from the profile switcher.
 */
const membershipSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    role: { type: String, enum: ORG_ROLES, required: true, default: "delegate" },

    /** which channels this person may publish to. empty means updatebase only. */
    channels: [{ type: String, enum: CHANNELS }],

    /** how many updates this person has published for the organization */
    updateCount: { type: Number, default: 0, min: 0 },

    invitedBy: { type: Schema.Types.ObjectId, ref: "User" },
    joinedAt: { type: Date, default: Date.now },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// one membership per person per organization
membershipSchema.index({ user: 1, organization: 1 }, { unique: true });
// the members list for an organization, newest first
membershipSchema.index({ organization: 1, role: 1, joinedAt: -1 });

export type MembershipAttrs = InferSchemaType<typeof membershipSchema>;
export type MembershipDoc = HydratedDocument<MembershipAttrs>;

export const Membership = model("Membership", membershipSchema);
