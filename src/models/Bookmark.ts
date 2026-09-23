import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const bookmarkSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subjectType: { type: String, enum: ["update", "testimonial"], required: true },
    subject: { type: Schema.Types.ObjectId, required: true, index: true },
    note: { type: String, maxlength: 280 },
  },
  { timestamps: true },
);

bookmarkSchema.index({ user: 1, subjectType: 1, subject: 1 }, { unique: true });
// the bookmarks page groups by month, so it reads in exactly this order
bookmarkSchema.index({ user: 1, createdAt: -1 });

export type BookmarkAttrs = InferSchemaType<typeof bookmarkSchema>;
export type BookmarkDoc = HydratedDocument<BookmarkAttrs>;

export const Bookmark = model("Bookmark", bookmarkSchema);
