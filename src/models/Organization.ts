import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CATEGORIES, CHANNELS, TIP_MODES } from "../types/domain";

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },

    handle: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-zA-Z0-9_]+$/,
    },
    handleLower: { type: String, required: true, unique: true, index: true },

    logoUrl: { type: String },
    bannerUrl: { type: String },

    /** written by the ai from the organization onboarding conversation */
    bio: { type: String, maxlength: 600 },
    tagline: { type: String, maxlength: 120 },

    /** the link that goes in the footer of every update, e.g. the whatsapp invite */
    communityLink: { type: String, trim: true },
    website: { type: String, trim: true },
    location: { city: String, country: String },

    categories: [{ type: String, enum: CATEGORIES }],

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ---- publishing ----
    /**
     * the running number that appears in each update, like "✅ 42".
     * incremented atomically when an update publishes.
     */
    updateCounter: { type: Number, default: 0, min: 0 },
    connectedChannels: [{ type: String, enum: CHANNELS }],

    // ---- money ----
    tipMode: { type: String, enum: TIP_MODES, default: "poster" },
    /** only read when tipMode is "split". the rest goes to the poster. */
    orgSharePercent: { type: Number, default: 30, min: 0, max: 100 },

    // ---- counters ----
    followerCount: { type: Number, default: 0, min: 0 },
    updateCount: { type: Number, default: 0, min: 0 },
    memberCount: { type: Number, default: 1, min: 1 },

    verifiedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

organizationSchema.pre("save", async function () {
  if (this.isModified("handle")) {
    this.handleLower = this.handle.toLowerCase();
  }
});

organizationSchema.index({ categories: 1, followerCount: -1 });
organizationSchema.index(
  { name: "text", handle: "text", bio: "text", tagline: "text" },
  { weights: { handle: 10, name: 8, tagline: 4, bio: 3 }, name: "org_search" },
);

export type OrganizationAttrs = InferSchemaType<typeof organizationSchema>;
export type OrganizationDoc = HydratedDocument<OrganizationAttrs>;

export const Organization = model("Organization", organizationSchema);
