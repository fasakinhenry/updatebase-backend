import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * one row per refresh token. storing a hash rather than the token means a
 * database leak does not hand anyone a working session, and rotation lets us
 * detect reuse of a token we already replaced.
 */
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    tokenHash: { type: String, required: true, unique: true, index: true },

    /** set when this token was rotated out, so reuse can be spotted */
    replacedByHash: { type: String, default: null },
    revokedAt: { type: Date, default: null },

    userAgent: { type: String },
    ip: { type: String },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// mongo removes expired sessions on its own, no cleanup job needed
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionAttrs = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = HydratedDocument<SessionAttrs>;

export const Session = model("Session", sessionSchema);
