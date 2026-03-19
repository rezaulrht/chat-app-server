const mongoose = require("mongoose");

const moduleSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // "text"        — standard channel everyone can post in
    // "announcement"— only admins/owner can post; members read-only
    // "voice"       — voice channel (LiveKit)
    type: {
      type: String,
      enum: ["text", "announcement", "voice"],
      default: "text",
    },

    isVoiceChannel: {
      type: Boolean,
      default: false,
    },

    activeParticipants: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        joinedAt: Date,
      },
    ],

    // Must match one of the workspace's category names (string, not ObjectId)
    // null means "no category" (uncategorised)
    category: {
      type: String,
      trim: true,
      default: null,
    },

    // Lower number = higher in the list within its category
    position: {
      type: Number,
      default: 0,
    },

    // If true, only members listed in allowedMembers can see and post
    isPrivate: {
      type: Boolean,
      default: false,
    },

    // NEW: Role-based / Member-based access for private channels (Discord style overrides)
    permissionOverrides: [
      {
        targetId: {
          type: mongoose.Schema.Types.ObjectId, // Can be a User ID or a Role ID
          required: true,
        },
        targetType: {
          type: String,
          enum: ["member", "role"],
          required: true,
        },
        allow: [{ type: String }], // Array of PERMISSION strings
        deny: [{ type: String }],  // Array of PERMISSION strings
      },
    ],

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Mirrors Conversation.lastMessage — used by ModuleSidebar for preview
    lastMessage: {
      text: { type: String, default: "" },
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      timestamp: { type: Date, default: null },
    },

    // Unread count per workspace member — same Map pattern as Conversation
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true },
);

// ── Validation ──────────────────────────────────────────────────
moduleSchema.pre("validate", function () {
  if (!this.name || !this.name.trim()) {
    throw new Error("Module name is required");
  }
});

// ── Indexes ─────────────────────────────────────────────────────

// Primary: list all modules in a workspace
moduleSchema.index({ workspaceId: 1, position: 1 });

// Category grouping
moduleSchema.index({ workspaceId: 1, category: 1 });

module.exports = mongoose.model("Module", moduleSchema);
