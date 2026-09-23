import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const commentSchema = new Schema(
  {
    subjectType: { type: String, enum: ["update", "testimonial"], required: true },
    subject: { type: Schema.Types.ObjectId, required: true, index: true },

    author: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /**
     * set when someone comments as an organization rather than as themselves,
     * which is what makes organizations replying to each other work.
     */
    asOrganization: { type: Schema.Types.ObjectId, ref: "Organization", default: null },

    body: { type: String, required: true, maxlength: 2000 },

    /** null for a top level comment, otherwise the comment being replied to */
    parent: { type: Schema.Types.ObjectId, ref: "Comment", default: null, index: true },
    /** the top level ancestor, so a whole thread is one query */
    thread: { type: Schema.Types.ObjectId, ref: "Comment", default: null, index: true },
    depth: { type: Number, default: 0, min: 0, max: 4 },

    /** users named with @, who each get a dm about it */
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],

    loveCount: { type: Number, default: 0, min: 0 },
    replyCount: { type: Number, default: 0, min: 0 },

    editedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// the comment list under something, oldest first so a conversation reads down
commentSchema.index({ subject: 1, subjectType: 1, parent: 1, createdAt: 1 });
commentSchema.index({ thread: 1, createdAt: 1 });

export type CommentAttrs = InferSchemaType<typeof commentSchema>;
export type CommentDoc = HydratedDocument<CommentAttrs>;

export const Comment = model("Comment", commentSchema);
