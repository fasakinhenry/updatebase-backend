import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const mediaSchema = new Schema(
  {
    url: { type: String, required: true },
    kind: { type: String, enum: ["image", "video"], required: true },
    width: { type: Number },
    height: { type: Number },
    blurhash: { type: String },
    alt: { type: String, maxlength: 400 },
  },
  { _id: false },
);

/**
 * a testimonial always quotes at least one update. that rule is the whole
 * point: it closes the loop back to whoever posted the thing that worked.
 */
const testimonialSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    body: { type: String, required: true, maxlength: 4000 },

    /** one or more. enforced in the route, since mongoose cannot require a minimum. */
    quotedUpdates: [{ type: Schema.Types.ObjectId, ref: "Update", required: true }],

    media: [mediaSchema],

    celebrateCount: { type: Number, default: 0, min: 0 },
    commentCount: { type: Number, default: 0, min: 0 },
    repostCount: { type: Number, default: 0, min: 0 },
    bookmarkCount: { type: Number, default: 0, min: 0 },

    rankScore: { type: Number, default: 0, index: true },

    publishedAt: { type: Date, default: Date.now, index: true },
    editedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
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

// "what did this update lead to", which is what the poster wants to see
testimonialSchema.index({ quotedUpdates: 1, publishedAt: -1 });
testimonialSchema.index({ author: 1, publishedAt: -1 });
testimonialSchema.index({ rankScore: -1, publishedAt: -1 });
testimonialSchema.index({ body: "text" }, { name: "testimonial_search" });

export type TestimonialAttrs = InferSchemaType<typeof testimonialSchema>;
export type TestimonialDoc = HydratedDocument<TestimonialAttrs>;

export const Testimonial = model("Testimonial", testimonialSchema);
