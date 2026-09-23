import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * one row per follow. the target is either an organization or another person,
 * which is why it carries its own type rather than two nullable references.
 */
const followSchema = new Schema(
  {
    follower: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetType: { type: String, enum: ["user", "organization"], required: true },
    target: { type: Schema.Types.ObjectId, required: true, index: true },
    /** true once they follow each other, which weights the testimonial feed */
    mutual: { type: Boolean, default: false },
  },
  { timestamps: true },
);

followSchema.index({ follower: 1, targetType: 1, target: 1 }, { unique: true });
// "who follows this organization", newest first
followSchema.index({ target: 1, targetType: 1, createdAt: -1 });
// "everything this person follows", which is the following feed's first step
followSchema.index({ follower: 1, targetType: 1, createdAt: -1 });

export type FollowAttrs = InferSchemaType<typeof followSchema>;
export type FollowDoc = HydratedDocument<FollowAttrs>;

export const Follow = model("Follow", followSchema);
