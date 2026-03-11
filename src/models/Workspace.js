const mongoose = require("mongoose");

const MAX_WORKSPACE_MEMBERS = 500;

// ── Sub-schemas ──────────────────────────────────────────────────

// Categories are embedded subdocuments — no separate model needed
const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  position: { type: Number, default: 0 },
});

// Members are embedded with a role field
const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ["owner", "admin", "member"], default: "member" },
  joinedAt: { type: Date, default: Date.now },
  nickname: { type: String, trim: true, maxlength: 50, default: null },
});

// ── Main schema ──────────────────────────────────────────────────

const workspaceSchema = new mongoose.Schema(
  {
    // Display name of the workspace
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    // Optional description
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // Optional avatar URL
    avatar: {
      type: String,
      default: null,
    },

    // User who created the workspace (immutable owner seed)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // "public" workspaces are discoverable; "private" are invite-only
    visibility: {
      type: String,
      enum: ["public", "private"],
      default: "private",
    },

    // Embedded member list with roles
    members: [memberSchema],

    // Embedded category list (ordered by position field)
    categories: [categorySchema],

    // Invite link code — null means no active invite link
    inviteCode: {
      type: String,
      default: null,
    },

    // null = never expires (infinite); otherwise a UTC Date
    inviteCodeExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// ── Validation hook ──────────────────────────────────────────────

workspaceSchema.pre("validate", function () {
  if (!this.name || !this.name.trim()) {
    throw new Error("Workspace name is required");
  }
  if (this.members.length > MAX_WORKSPACE_MEMBERS) {
    throw new Error(`Workspace cannot exceed ${MAX_WORKSPACE_MEMBERS} members`);
  }
});

// ── Indexes ──────────────────────────────────────────────────────

// Fast lookup: find all workspaces a user is a member of
workspaceSchema.index({ "members.user": 1 });

// Invite code lookup — unique only when a code exists (null workspaces are excluded)
workspaceSchema.index(
  { inviteCode: 1 },
  {
    unique: true,
    partialFilterExpression: { inviteCode: { $type: "string" } },
  },
);

// ── Exports ──────────────────────────────────────────────────────

module.exports = mongoose.model("Workspace", workspaceSchema);
module.exports.MAX_WORKSPACE_MEMBERS = MAX_WORKSPACE_MEMBERS;
