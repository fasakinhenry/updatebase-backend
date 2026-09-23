import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { CATEGORIES, CHANNELS } from "../types/domain";

const mediaSchema = new Schema(
  {
    url: { type: String, required: true },
    kind: { type: String, enum: ["image", "video"], required: true },
    // stored so the client can reserve the right box and never shift layout
    width: { type: Number },
    height: { type: Number },
    blurhash: { type: String },
    alt: { type: String, maxlength: 400 },
  },
  { _id: false },
);

const updateSchema = new Schema(
  {
    organization: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /** the delegate who wrote it. hidden in the ui when the org posts anonymously. */
    author: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** false when the org chose not to credit posters */
    attributed: { type: Boolean, default: true },

    // ---- the update itself. casing is the community's, never ours. ----
    /** the category line, e.g. "🎓 scholarship update" */
    header: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 4000 },
    /** the running number shown as "✅ 42" */
    number: { type: Number, required: true, min: 1 },
    footer: { type: String, maxlength: 400 },

    category: { type: String, enum: CATEGORIES, required: true, index: true },
    tags: [{ type: String, lowercase: true, trim: true, maxlength: 40 }],

    /** where people actually apply */
    link: { type: String, trim: true },
    media: [mediaSchema],

    // ---- where it went ----
    channels: [{ type: String, enum: CHANNELS }],
    /** the per channel rendering, so copying later never re-runs the ai */
    renderings: { type: Map, of: String, default: undefined },

    // ---- eligibility, used for ranking ----
    deadline: { type: Date, index: true },
    /** iso country codes, empty means open to everyone */
    eligibleCountries: [{ type: String, uppercase: true, maxlength: 2 }],
    isRemote: { type: Boolean, default: false },

    // ---- counters, denormalized so a feed page is one query ----
    loveCount: { type: Number, default: 0, min: 0 },
    commentCount: { type: Number, default: 0, min: 0 },
    repostCount: { type: Number, default: 0, min: 0 },
    quoteCount: { type: Number, default: 0, min: 0 },
    bookmarkCount: { type: Number, default: 0, min: 0 },
    testimonialCount: { type: Number, default: 0, min: 0 },
    tipTotal: { type: Number, default: 0, min: 0 },
    viewCount: { type: Number, default: 0, min: 0 },

    /**
     * recomputed when engagement changes. sorting on a stored score keeps the
     * for you feed a single indexed query rather than a scan and a sort.
     */
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

/** the whole update as one block of text, which is what gets copied out. */
updateSchema.virtual("fullText").get(function () {
  const parts = [this.header, "", `✅ ${this.number}`, this.body];
  if (this.link) parts.push("", `🔗 ${this.link}`);
  if (this.footer) parts.push("", this.footer);
  return parts.join("\n");
});

// the following feed: updates from a set of organizations, newest first
updateSchema.index({ organization: 1, publishedAt: -1 });
// the for you feed: by interest category, best first
updateSchema.index({ category: 1, rankScore: -1, publishedAt: -1 });
// trending
updateSchema.index({ rankScore: -1, publishedAt: -1 });
// full text search across the parts a person would actually search
updateSchema.index(
  { header: "text", body: "text", tags: "text" },
  { weights: { header: 6, tags: 4, body: 2 }, name: "update_search" },
);

export type UpdateAttrs = InferSchemaType<typeof updateSchema>;
export type UpdateDoc = HydratedDocument<UpdateAttrs>;

export const Update = model("Update", updateSchema);
