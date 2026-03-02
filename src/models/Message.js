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
    // Populated for DMs; null for group messages
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },

    // ── Group-only delivery / read tracking ───────────────────────
    // Each entry records when a specific participant received the message
    deliveredTo: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        deliveredAt: { type: Date },
      },
    ],

    // Each entry records when a specific participant read the message
    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        readAt: { type: Date },
      },
    ],
    // ──────────────────────────────────────────────────────────────

    text: {
      type: String,
      trim: true,
      default: null,
    },
    gifUrl: {
      type: String,
      trim: true,
      default: null,
    },

    // ✅ NEW: Thread Reply Field
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
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
    reactions: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: {},
    },
  },
  { timestamps: true },
);

// Fast paginated history queries: fetch messages for a conversation sorted by time
messageSchema.index({ conversationId: 1, createdAt: -1 });

// Index for bulk updates: find all messages for a conversation up to a specific message
messageSchema.index({ conversationId: 1, _id: 1 });

// DM-only: find undelivered or unseen messages by receiver — partial index skips group messages
messageSchema.index(
  { receiverId: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { receiverId: { $ne: null } } },
);

// Group-only: efficiently query which participants have read a message
messageSchema.index({ conversationId: 1, "readBy.user": 1 });

// Reply index
messageSchema.index({ replyTo: 1 });

module.exports = mongoose.model("Message", messageSchema);
