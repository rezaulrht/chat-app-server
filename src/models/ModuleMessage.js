const mongoose = require("mongoose");

const moduleMessageSchema = new mongoose.Schema(
  {
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Module",
      required: true,
    },

    // Stored directly for fast workspace-level queries without populate
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    text: {
      type: String,
      trim: true,
      // Not required at schema level — gifUrl can substitute. Validate in controller.
    },

    gifUrl: {
      type: String,
      default: null,
    },

    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ModuleMessage",
      default: null,
    },

    // Per-user read tracking (same shape as Message.readBy)
    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        readAt: { type: Date },
      },
    ],

    // Emoji reactions: Map<emojiString → [userId]>
    reactions: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: {},
    },

    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false },

    // Soft-delete per user — message hidden only for listed users
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

// ── Indexes ─────────────────────────────────────────────────────

// Primary: paginated history for a module
moduleMessageSchema.index({ moduleId: 1, createdAt: -1 });

// Compound for "up to message" range queries (mark-seen feature)
moduleMessageSchema.index({ moduleId: 1, _id: 1 });

// Sender history
moduleMessageSchema.index({ sender: 1, createdAt: -1 });

module.exports = mongoose.model("ModuleMessage", moduleMessageSchema);
