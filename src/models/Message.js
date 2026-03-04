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
      required: true,
      trim: true,
    },

    //  NEW: Thread Reply Field
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    // Scheduled Messages
    scheduledFromId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScheduledMessage",
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

    // ADD BELOW status fields

    isEdited: {
      type: Boolean,
      default: false,
    },

    editedAt: {
      type: Date,
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

// Fast paginated history queries: fetch messages for a conversation sorted by time
messageSchema.index({ conversationId: 1, createdAt: -1 });

// sender fast load
messageSchema.index({ sender: 1, createdAt: -1 });

// Delete for Me query fast
messageSchema.index({ deletedFor: 1 });

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

// Scheduled Messages
messageSchema.index({ scheduledFromId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Message", messageSchema);
