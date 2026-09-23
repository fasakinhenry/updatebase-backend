import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CAREER_STAGES, CATEGORIES, VISIBILITY } from "../types/domain";

const userSchema = new Schema(
  {
    // ---- identity ----
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    emailVerifiedAt: { type: Date, default: null },

    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      // lowercase, letters numbers and underscore. stored as typed so the
      // display keeps the user's capitalisation, matched case insensitively.
      match: /^[a-zA-Z0-9_]+$/,
    },
    /** lowercased copy of username, so uniqueness ignores case */
    usernameLower: { type: String, unique: true, sparse: true, index: true },

    name: { type: String, trim: true, maxlength: 60 },
    gender: { type: String, enum: ["woman", "man", "non-binary", "prefer-not-to-say"] },
    dateOfBirth: { type: Date },

    // ---- credentials ----
    // absent when the account only ever signed in with google
    passwordHash: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, index: true },

    // ---- presentation ----
    /** dicebear seed. the avatar is derived from it, never stored as a file. */
    avatarSeed: { type: String },
    avatarStyle: { type: String, default: "notionists" },
    /** an uploaded photo or the google picture. wins over the avatar when set. */
    photoUrl: { type: String },
    /** which of the two the user chose to show */
    avatarMode: { type: String, enum: ["avatar", "photo"], default: "avatar" },
    bannerUrl: { type: String },

    /** written by the ai at the end of onboarding, editable afterwards */
    bio: { type: String, maxlength: 600 },

    // ---- onboarding and personalization ----
    interests: [{ type: String, enum: CATEGORIES }],
    careerStage: { type: String, enum: CAREER_STAGES },
    school: { type: String, trim: true, maxlength: 120 },
    company: { type: String, trim: true, maxlength: 120 },
    profession: { type: String, trim: true, maxlength: 120 },
    yearsOfExperience: { type: Number, min: 0, max: 70 },
    goals: {
      shortTerm: { type: String, maxlength: 400 },
      longTerm: { type: String, maxlength: 400 },
    },

    location: {
      /** [longitude, latitude], the order geojson requires */
      coordinates: { type: [Number], default: undefined },
      city: { type: String },
      country: { type: String },
      grantedAt: { type: Date },
    },

    onboarding: {
      profileCompletedAt: { type: Date, default: null },
      conversationCompletedAt: { type: Date, default: null },
      locationPromptedAt: { type: Date, default: null },
    },

    // ---- settings ----
    profileVisibility: { type: String, enum: VISIBILITY, default: "public" },
    /** while set and in the future, nobody new can start a dm */
    dmsPausedUntil: { type: Date, default: null },
    theme: { type: String, enum: ["light", "dark", "system"], default: "light" },

    /** public key others use to encrypt messages to this user */
    messagingPublicKey: { type: String },
    /** private key, encrypted on the client. the server can never read it. */
    messagingPrivateKeyEncrypted: { type: String, select: false },

    // ---- counters, denormalized so a profile is one read ----
    followerCount: { type: Number, default: 0, min: 0 },
    followingCount: { type: Number, default: 0, min: 0 },

    lastActiveAt: { type: Date, default: Date.now },
    suspendedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.passwordHash;
        delete ret.messagingPrivateKeyEncrypted;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** onboarding is only done when all three steps are behind the user. */
userSchema.virtual("onboardingComplete").get(function () {
  return Boolean(
    this.onboarding?.profileCompletedAt && this.onboarding?.conversationCompletedAt,
  );
});

// keep the lowercased copy in step, so uniqueness ignores capitalisation
// while the profile still shows the username the way it was typed
userSchema.pre("save", async function () {
  if (this.isModified("username") && this.username) {
    this.usernameLower = this.username.toLowerCase();
  }
});

// feed ranking reads interests and location together
userSchema.index({ interests: 1 });
userSchema.index({ "location.coordinates": "2dsphere" }, { sparse: true });
// discover search across the human readable fields
userSchema.index(
  { name: "text", username: "text", bio: "text", school: "text", company: "text" },
  { weights: { username: 10, name: 8, bio: 4, school: 2, company: 2 }, name: "user_search" },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = model("User", userSchema);
