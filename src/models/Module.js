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
    type: {
      type: String,
      enum: ["text", "announcement"],
      default: "text",
    },

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

    // Only relevant when isPrivate === true
    allowedMembers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // NEW: Role-based access for private channels
    allowedRoles: [
      {
        type: mongoose.Schema.Types.ObjectId, // Refs to workspace.roles (it's embedded but we can store ID)
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
