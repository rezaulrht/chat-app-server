const mongoose = require("mongoose");

const MAX_GROUP_SIZE = 50;

const conversationSchema = new mongoose.Schema(
  {
    // "dm" for direct messages, "group" for group chats
    type: {
      type: String,
      enum: ["dm", "group"],
      default: "dm",
    },

    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],

    // ── Group-only fields ──────────────────────────────────────────
    // Display name of the group (required for groups)
    name: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    // Group description
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    // Optional group avatar URL
    avatar: {
      type: String,
      default: null,
    },

    // User who created the group (immutable owner)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Users with admin privileges (subset of participants)
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    // ──────────────────────────────────────────────────────────────

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

// ── Validation hook ──────────────────────────────────────────────
conversationSchema.pre("validate", async function () {
  if (this.type === "group") {
    if (!this.name || !this.name.trim()) {
      throw new Error("Group conversations must have a name");
    }
    if (!this.createdBy) {
      throw new Error("Group conversations must have a createdBy field");
    }
    if (!this.participants || this.participants.length < 3) {
      throw new Error("Group conversations must have at least 3 participants");
    }
    if (this.participants.length > MAX_GROUP_SIZE) {
      throw new Error(
        `Group conversations cannot exceed ${MAX_GROUP_SIZE} participants`,
      );
    }
  }
});

// ── Indexes ──────────────────────────────────────────────────────

// Fast lookup: find all conversations a user is part of
conversationSchema.index({ participants: 1 });

// Compound: used by participant-based pagination and DM duplicate checks
conversationSchema.index({ participants: 1, _id: 1 });

// ── Instance Methods ─────────────────────────────────────────────

conversationSchema.methods.getUnreadMap = function () {
  if (!this.unreadCount) {
    this.unreadCount = new Map();
  }

  return this.unreadCount;
};

module.exports = mongoose.model("Conversation", conversationSchema);
module.exports.MAX_GROUP_SIZE = MAX_GROUP_SIZE;
