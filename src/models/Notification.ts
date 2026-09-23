import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { NOTIFICATION_KINDS } from "../types/domain";

const notificationSchema = new Schema(
  {
    /** who sees it */
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** when the notification is for an organization rather than a person */
    recipientOrganization: { type: Schema.Types.ObjectId, ref: "Organization", default: null },

    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },

    /** who caused it. absent for system notifications. */
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorOrganization: { type: Schema.Types.ObjectId, ref: "Organization", default: null },

    /** what it is about */
    subjectType: {
      type: String,
      enum: ["update", "testimonial", "comment", "organization", "user", "wallet"],
    },
    subject: { type: Schema.Types.ObjectId },

    /** a short preview so the list needs no extra lookups to render */
    preview: { type: String, maxlength: 280 },
    /** where tapping it should go */
    link: { type: String },

    readAt: { type: Date, default: null },
    /** notifications older than this are cleared out automatically */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

// the notifications page, newest first
notificationSchema.index({ recipient: 1, createdAt: -1 });
// the unread badge
notificationSchema.index({ recipient: 1, readAt: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type NotificationAttrs = InferSchemaType<typeof notificationSchema>;
export type NotificationDoc = HydratedDocument<NotificationAttrs>;

export const Notification = model("Notification", notificationSchema);
