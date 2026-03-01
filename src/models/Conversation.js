const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    lastMessage: {
      text: {
        type: String,
        default: "",
      },
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      timestamp: {
        type: Date,
        default: null,
      },
    },
    // Unread message count per participant
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
    // Pinned status per participant
    pinnedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    // Archived status per participant
    archivedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    // Muted status per participant
    mutedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

// Fast lookup: find all conversations a user is part of
conversationSchema.index({ participants: 1 });

// Prevent duplicate conversations between the same two users
conversationSchema.index({ participants: 1, _id: 1 });

conversationSchema.methods.getUnreadMap = function () {
  if (!this.unreadCount) {
    this.unreadCount = new Map();
  }

  return this.unreadCount;
};

module.exports = mongoose.model("Conversation", conversationSchema);
