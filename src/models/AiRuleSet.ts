import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const exampleSchema = new Schema(
  {
    /** what was pasted in */
    input: { type: String, required: true, maxlength: 4000 },
    /** what it should have come out as */
    output: { type: String, required: true, maxlength: 4000 },
    note: { type: String, maxlength: 200 },
  },
  { _id: true, timestamps: true },
);

/**
 * everything an organization has taught the formatter. one per organization,
 * edited from the composer's settings and applied to every update it writes.
 */
const aiRuleSetSchema = new Schema(
  {
    organization: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
      index: true,
    },

    /** free text rules, in the org's own words */
    rules: [{ type: String, maxlength: 400 }],

    /** worked examples, which teach style far better than any rule can */
    examples: [exampleSchema],

    // ---- the mechanical parts, kept structured so they are never guessed ----
    lowercase: { type: Boolean, default: true },
    /** the line appended to every update, e.g. the community invite link */
    footer: { type: String, maxlength: 400 },
    /** "USERNAME from Organization". the template the signature follows. */
    signatureTemplate: { type: String, default: "{username} from {organization}", maxlength: 120 },
    showNumber: { type: Boolean, default: true },
    numberPrefix: { type: String, default: "✅", maxlength: 8 },

    /** the emoji vocabulary this community uses, so the model reuses theirs */
    emojiVocabulary: [{ type: String, maxlength: 8 }],

    /** overrides the default header for a category, when they word it their way */
    categoryHeaders: { type: Map, of: String, default: undefined },

    /** an extra instruction block, for anything the fields above cannot say */
    customPrompt: { type: String, maxlength: 2000 },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type AiRuleSetAttrs = InferSchemaType<typeof aiRuleSetSchema>;
export type AiRuleSetDoc = HydratedDocument<AiRuleSetAttrs>;

export const AiRuleSet = model("AiRuleSet", aiRuleSetSchema);
