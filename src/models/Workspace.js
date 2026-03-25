const mongoose = require("mongoose");

const MAX_WORKSPACE_MEMBERS = 500;

// ── Permission Constants ─────────────────────────────────────────
const PERMISSIONS = {
  ADMINISTRATOR: "ADMINISTRATOR",
  MANAGE_WORKSPACE: "MANAGE_WORKSPACE",
  MANAGE_ROLES: "MANAGE_ROLES",
  MANAGE_CHANNELS: "MANAGE_CHANNELS",
  KICK_MEMBERS: "KICK_MEMBERS",
  CREATE_INVITES: "CREATE_INVITES",
  MANAGE_MESSAGES: "MANAGE_MESSAGES",
  SEND_MESSAGES: "SEND_MESSAGES",
  VIEW_CHANNEL: "VIEW_CHANNEL",
};

// ── Sub-schemas ──────────────────────────────────────────────────

// Categories are embedded subdocuments — no separate model needed
const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  position: { type: Number, default: 0 },
});

// Role defintion schema
const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  color: { type: String, default: "#99AAB5" }, // Discord-ish default gray
  permissions: [{ type: String, enum: Object.values(PERMISSIONS) }], // Array of permission strings
  position: { type: Number, default: 0 }, // Higher = more priority
  isHoisted: { type: Boolean, default: false }, // Display separately in member list
});

// Members are embedded with a role field
const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // Legacy role for backwards compatibility, we will migrate to roleIds
  role: { type: String, enum: ["owner", "admin", "member"], default: "member" },
  roleIds: [{ type: mongoose.Schema.Types.ObjectId }], // Refs to workspace.roles
  joinedAt: { type: Date, default: Date.now },
  nickname: { type: String, trim: true, maxlength: 50, default: null },
});

const bannedUserSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  bannedAt: { type: Date, default: Date.now },
  bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  reason:   { type: String, trim: true, maxlength: 200, default: null },
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
    
    // NEW: Banner image for customization
    banner: {
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

    // Banned users list
    bannedUsers: [bannedUserSchema],

    // Embedded category list (ordered by position field)
    categories: [categorySchema],

    // NEW: Role definitions
    roles: [roleSchema],

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
module.exports.PERMISSIONS = PERMISSIONS;
