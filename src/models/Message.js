const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    seenAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Fast paginated history queries: fetch messages for a conversation sorted by time
messageSchema.index({ conversationId: 1, createdAt: -1 });

// Index for bulk updates: find all messages for a conversation up to a specific message
messageSchema.index({ conversationId: 1, _id: 1 });

// Index for delivered/seen status queries: find undelivered or unseen messages
messageSchema.index({ receiverId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
