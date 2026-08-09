import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const messageSchema = new Schema(
  {
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    chatId: { type: String, required: true },
    // whatsapp-web.js message.id._serialized — the stable identifier used to
    // deduplicate messages that WhatsApp may emit/replay more than once.
    messageId: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    body: { type: String, default: "" },
    fromMe: { type: Boolean, required: true },
    ack: { type: Number },
    timestamp: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ sessionId: 1, messageId: 1 }, { unique: true });
messageSchema.index({ sessionId: 1, chatId: 1, timestamp: -1 });

export type MessageDoc = InferSchemaType<typeof messageSchema>;

export const Message: Model<MessageDoc> = models.Message || model<MessageDoc>("Message", messageSchema);
