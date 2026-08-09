import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const chatSchema = new Schema(
  {
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    chatId: { type: String, required: true },
    name: { type: String, required: true },
    isGroup: { type: Boolean, default: false },
    unreadCount: { type: Number, default: 0 },
    lastMessage: { type: String },
    lastMessageAt: { type: Date },
  },
  { timestamps: true },
);

chatSchema.index({ sessionId: 1, chatId: 1 }, { unique: true });
chatSchema.index({ sessionId: 1, lastMessageAt: -1 });

export type ChatDoc = InferSchemaType<typeof chatSchema>;

export const Chat: Model<ChatDoc> = models.Chat || model<ChatDoc>("Chat", chatSchema);
