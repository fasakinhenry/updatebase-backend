import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { REACTIONS } from "../types/domain";

/**
 * love belongs to updates, celebrate belongs to testimonials. one collection
 * keeps "did i react to this" a single indexed lookup either way.
 */
const reactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subjectType: { type: String, enum: ["update", "testimonial", "comment"], required: true },
    subject: { type: Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: REACTIONS, required: true },
  },
  { timestamps: true },
);

// one reaction of a kind per person per thing
reactionSchema.index({ user: 1, subjectType: 1, subject: 1, kind: 1 }, { unique: true });
reactionSchema.index({ subject: 1, subjectType: 1, createdAt: -1 });

export type ReactionAttrs = InferSchemaType<typeof reactionSchema>;
export type ReactionDoc = HydratedDocument<ReactionAttrs>;

export const Reaction = model("Reaction", reactionSchema);
