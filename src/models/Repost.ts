import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * a plain repost carries no text. a quote does, and may add a testimonial
 * instead, which is how "quote this update with my story" works.
 */
const repostSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subjectType: { type: String, enum: ["update", "testimonial"], required: true },
    subject: { type: Schema.Types.ObjectId, required: true, index: true },

    kind: { type: String, enum: ["repost", "quote"], required: true },
    /** only present on a quote */
    body: { type: String, maxlength: 2000 },

    loveCount: { type: Number, default: 0, min: 0 },
    commentCount: { type: Number, default: 0, min: 0 },

    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// a plain repost is once per person per thing. quotes can repeat.
repostSchema.index(
  { user: 1, subjectType: 1, subject: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "repost" } },
);
repostSchema.index({ user: 1, createdAt: -1 });
repostSchema.index({ subject: 1, subjectType: 1, createdAt: -1 });

export type RepostAttrs = InferSchemaType<typeof repostSchema>;
export type RepostDoc = HydratedDocument<RepostAttrs>;

export const Repost = model("Repost", repostSchema);
