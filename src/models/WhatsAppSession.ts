import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { WHATSAPP_STATUSES } from "@/types/whatsapp";

const whatsAppSessionSchema = new Schema(
  {
    // Owning app user (single-admin MVP, but kept for future multi-user support).
    userId: { type: String, required: true },
    // Fixed session identifier for this MVP's single WhatsApp account.
    sessionId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: WHATSAPP_STATUSES,
      default: "DISCONNECTED",
      required: true,
    },
    phoneNumber: { type: String },
    pushName: { type: String },
    wid: { type: String },
    lastConnectedAt: { type: Date },
    lastDisconnectedAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true },
);

export type WhatsAppSessionDoc = InferSchemaType<typeof whatsAppSessionSchema>;

export const WhatsAppSession: Model<WhatsAppSessionDoc> =
  models.WhatsAppSession || model<WhatsAppSessionDoc>("WhatsAppSession", whatsAppSessionSchema);
