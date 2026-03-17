/**
 * Workspace controller
 *
 * Handles: create, list, get details, update, delete workspace,
 *          member management, role updates, leave workspace,
 *          invite link generation/revocation, category management.
 *
 * Socket events emitted via req.app.get("io"):
 *   workspace:created          — emitted to room after workspace creation
 *   workspace:updated          — emitted to room after name/description/avatar/visibility change
 *   workspace:deleted          — emitted to room before deletion so clients can react
 *   workspace:member-joined    — emitted to room when members are added or join via invite
 *   workspace:member-left      — emitted to room when a member leaves or is removed
 *   workspace:kicked           — emitted directly to each removed user's sockets
 *   workspace:role-updated     — emitted to room when a member's role changes
 *   workspace:owner-transferred — emitted to room when ownership transfers on leave
 *
 * Socket room convention: "workspace:<workspaceId>"
 * io is always retrieved via req.app.get("io").
 */

const User = require("../models/User");
const Workspace = require("../models/Workspace");
const { MAX_WORKSPACE_MEMBERS } = require("../models/Workspace");
const Module = require("../models/Module");
const ModuleMessage = require("../models/ModuleMessage");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// POST /api/workspaces
// Create a new workspace. The creator is automatically set as the owner.
// Body: { name, description?, avatar?, visibility? }
// ---------------------------------------------------------------------------
exports.createWorkspace = async (req, res) => {
  try {
    const creatorId = req.user.id;
    const { name, description, avatar, visibility } = req.body;

    // ── Validate name ────────────────────────────────────────────
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Workspace name is required" });
    }
    if (name.trim().length > 100) {
      return res
        .status(400)
        .json({ message: "Workspace name must be 100 characters or fewer" });
    }

    // ── Clamp visibility ─────────────────────────────────────────
    const safeVisibility =
      visibility === "public" || visibility === "private"
        ? visibility
        : "private";

    // ── Create the workspace ─────────────────────────────────────
    const workspace = await Workspace.create({
      name: name.trim(),
      description: description?.trim() || null,
      avatar: avatar || null,
      visibility: safeVisibility,
      createdBy: creatorId,
      members: [{ user: creatorId, role: "owner", joinedAt: new Date() }],
      categories: [{ name: "General", position: 0 }],
      inviteCode: null,
    });

    await workspace.populate({
      path: "members.user",
      select: "name avatar email",
    });

    // ── Seed default #general module ─────────────────────────────
    await Module.create({
      workspaceId: workspace._id,
      name: "general",
      type: "text",
      category: "General",
      position: 0,
      isPrivate: false,
      createdBy: creatorId,
    });

    // ── Socket: emit to room (empty until Member 3's handler auto-joins) ──
    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("workspace:created", {
        workspace,
      });
    }

    const result = {
      ...workspace.toObject(),
      myRole: "owner",
      memberCount: 1,
    };

    res.status(201).json(result);
  } catch (err) {
    console.error("createWorkspace error:", err.message);
    // Surface pre-validate hook errors as 400
    if (err.message.includes("Workspace")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces
// List all workspaces the authenticated user is a member of.
// Returns a lightweight shape — full member list is NOT included (too heavy).
// ---------------------------------------------------------------------------
exports.listMyWorkspaces = async (req, res) => {
  try {
    const userId = req.user.id;

    const workspaces = await Workspace.find({ "members.user": userId })
      .populate("createdBy", "name avatar")
      .sort({ createdAt: -1 });

    const result = workspaces.map((ws) => {
      const memberRecord = ws.members.find((m) => m.user.toString() === userId);
      return {
        _id: ws._id,
        name: ws.name,
        avatar: ws.avatar,
        description: ws.description,
        visibility: ws.visibility,
        myRole: memberRecord?.role || "member",
        memberCount: ws.members.length,
        createdBy: ws.createdBy,
        createdAt: ws.createdAt,
        categories: ws.categories || [],
      };
    });

    res.json(result);
  } catch (err) {
    console.error("listMyWorkspaces error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/discover
// List public workspaces for discovery.
// Query: query? (search by name), limit? (default 20)
// ---------------------------------------------------------------------------
exports.discoverWorkspaces = async (req, res) => {
  try {
    const { query, limit = 20 } = req.query;
    const filter = { visibility: "public" };

    if (query?.trim()) {
      const escapedQuery = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escapedQuery, $options: "i" };
    }

    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

    const workspaces = await Workspace.find(filter)
      .select("name description avatar banner createdBy members createdAt")
      .populate("createdBy", "name avatar")
      .limit(safeLimit)
      .sort({ createdAt: -1 });

    const result = workspaces.map((ws) => ({
      _id: ws._id,
      name: ws.name,
      avatar: ws.avatar,
      banner: ws.banner,
      description: ws.description,
      memberCount: ws.members.length,
      createdBy: ws.createdBy,
      createdAt: ws.createdAt,
    }));

    res.json(result);
  } catch (err) {
    console.error("discoverWorkspaces error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId
// Get full workspace details including populated members and categories.
// req.workspace and req.memberRecord are attached by middleware.
// ---------------------------------------------------------------------------
exports.getWorkspace = async (req, res) => {
  try {
    const workspace = req.workspace; // attached by loadWorkspace

    await workspace.populate([
      { path: "members.user", select: "name avatar email" },
      { path: "createdBy", select: "name avatar" },
    ]);

    res.json({
      ...workspace.toObject(),
      myRole: req.memberRecord.role,
    });
  } catch (err) {
    console.error("getWorkspace error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId
// Update workspace name, description, avatar, and/or visibility (admin+).
// Body: { name?, description?, avatar?, visibility? }
// ---------------------------------------------------------------------------
exports.updateWorkspace = async (req, res) => {
  try {
    const { name, description, avatar, banner, visibility } = req.body;
    const workspace = req.workspace; // attached by loadWorkspace

    // ── Require at least one field ───────────────────────────────
    if (
      name === undefined &&
      description === undefined &&
      avatar === undefined &&
      banner === undefined &&
      visibility === undefined
    ) {
      return res
        .status(400)
        .json({ message: "Provide at least one field to update" });
    }

    // ── Apply only the fields that are present ───────────────────
    if (name !== undefined) {
      if (!name.trim()) {
        return res
          .status(400)
          .json({ message: "Workspace name cannot be empty" });
      }
      if (name.trim().length > 100) {
        return res
          .status(400)
          .json({ message: "Workspace name must be 100 characters or fewer" });
      }
      workspace.name = name.trim();
    }

    if (description !== undefined) {
      workspace.description = description?.trim() || null;
    }

    if (avatar !== undefined) {
      workspace.avatar = avatar || null;
    }

    if (banner !== undefined) {
      workspace.banner = banner || null;
    }

    if (visibility !== undefined) {
      if (visibility !== "public" && visibility !== "private") {
        return res
          .status(400)
          .json({ message: 'visibility must be "public" or "private"' });
      }
      workspace.visibility = visibility;
    }

    await workspace.save();

    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("workspace:updated", {
        workspaceId: workspace._id,
        name: workspace.name,
        description: workspace.description,
        avatar: workspace.avatar,
        banner: workspace.banner,
        visibility: workspace.visibility,
      });
    }

    res.json({
      message: "Workspace updated",
      name: workspace.name,
      description: workspace.description,
      avatar: workspace.avatar,
      banner: workspace.banner,
      visibility: workspace.visibility,
    });
  } catch (err) {
    console.error("updateWorkspace error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId
// Permanently delete the workspace (owner only).
// Emits workspace:deleted BEFORE deletion so connected clients can react.
// ---------------------------------------------------------------------------
exports.deleteWorkspace = async (req, res) => {
  try {
    const workspace = req.workspace; // attached by loadWorkspace
    const workspaceId = workspace._id;

    // Notify connected clients before the document is gone
    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${workspaceId}`).emit("workspace:deleted", {
        workspaceId,
        deletedBy: req.user.id,
      });
    }

    // Cascade delete all modules and their messages
    await ModuleMessage.deleteMany({ workspaceId });
    await Module.deleteMany({ workspaceId });

    await workspace.deleteOne();

    res.json({ message: "Workspace deleted" });
  } catch (err) {
    console.error("deleteWorkspace error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/members/add
// Add one or more users to the workspace (admin+).
// Body: { userIds: [...] }
// ---------------------------------------------------------------------------
exports.addMembers = async (req, res) => {
  try {
    const { userIds } = req.body;
    const workspace = req.workspace;
    const wsId = workspace._id;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "userIds array is required" });
    }

    const uniqueIds = [...new Set(userIds.map(String))];

    // Strip users who are already members
    const existingIds = workspace.members.map((m) => m.user.toString());
    const toAdd = uniqueIds.filter((id) => !existingIds.includes(id));

    if (toAdd.length === 0) {
      return res
        .status(400)
        .json({ message: "All provided users are already members" });
    }

    if (existingIds.length + toAdd.length > MAX_WORKSPACE_MEMBERS) {
      return res.status(400).json({
        message: `Cannot exceed ${MAX_WORKSPACE_MEMBERS} members. Current: ${existingIds.length}, trying to add: ${toAdd.length}`,
      });
    }

    // Verify all IDs exist in the User collection
    const foundUsers = await User.find({ _id: { $in: toAdd } }).select(
      "_id name avatar email",
    );
    if (foundUsers.length !== toAdd.length) {
      return res
        .status(400)
        .json({ message: "One or more user IDs are invalid" });
    }

    const newEntries = foundUsers.map((u) => ({
      user: u._id,
      role: "member",
      joinedAt: new Date(),
    }));

    await Workspace.findByIdAndUpdate(wsId, {
      $push: { members: { $each: newEntries } },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${wsId}`).emit("workspace:member-joined", {
        workspaceId: wsId,
        addedBy: req.user.id,
        newMembers: foundUsers,
      });
    }

    res.json({
      message: `${foundUsers.length} member(s) added`,
      addedMembers: foundUsers,
    });
  } catch (err) {
    console.error("addMembers error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/members/remove
// Remove one or more members from the workspace (admin+).
// Body: { userIds: [...] }
// Rules:
//   - Cannot remove the owner
//   - Non-owner admins cannot remove other admins — only the owner can
// ---------------------------------------------------------------------------
exports.removeMembers = async (req, res) => {
  try {
    const { userIds } = req.body;
    const workspace = req.workspace;
    const wsId = workspace._id;
    const requesterId = req.user.id;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "userIds array is required" });
    }

    const uniqueIds = [...new Set(userIds.map(String))];

    // Identify the owner
    const ownerRecord = workspace.members.find((m) => m.role === "owner");
    const ownerId = ownerRecord?.user.toString();

    if (uniqueIds.includes(ownerId)) {
      return res
        .status(400)
        .json({ message: "The workspace owner cannot be removed" });
    }

    // Non-owner admins cannot remove other admins
    if (requesterId !== ownerId) {
      const adminIds = workspace.members
        .filter((m) => m.role === "admin")
        .map((m) => m.user.toString());
      const tryingToRemoveAdmin = uniqueIds.some((id) => adminIds.includes(id));
      if (tryingToRemoveAdmin) {
        return res.status(403).json({
          message: "Only the workspace owner can remove other admins",
        });
      }
    }

    // Only remove IDs that are actually members
    const memberIds = workspace.members.map((m) => m.user.toString());
    const validTargets = uniqueIds.filter((id) => memberIds.includes(id));

    if (validTargets.length === 0) {
      return res.status(400).json({
        message: "None of the provided users are members of this workspace",
      });
    }

    await Workspace.findByIdAndUpdate(wsId, {
      $pull: { members: { user: { $in: validTargets } } },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${wsId}`).emit("workspace:member-left", {
        workspaceId: wsId,
        removedBy: requesterId,
        removedUserIds: validTargets,
      });

      // Notify each removed user directly on all their active sockets
      for (const userId of validTargets) {
        const socketIds = getIsRedisConnected()
          ? await redisClient.sMembers(`sockets:${userId}`).catch(() => [])
          : [];
        for (const sid of socketIds) {
          io.to(sid).emit("workspace:kicked", { workspaceId: wsId });
        }
      }
    }

    res.json({
      message: `${validTargets.length} member(s) removed`,
      removedUserIds: validTargets,
    });
  } catch (err) {
    console.error("removeMembers error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/members/:targetUserId/role
// Promote or demote a member between "admin" and "member" (admin+).
// Cannot set role to "owner" — ownership transfers only via leaveWorkspace.
// Body: { role: "admin" | "member" }
// ---------------------------------------------------------------------------
exports.updateMemberRole = async (req, res) => {
  try {
    const { role } = req.body;
    const { targetUserId } = req.params;
    const workspace = req.workspace;
    const wsId = workspace._id;
    const requesterId = req.user.id;

    // Only "admin" and "member" are settable via this endpoint
    if (role !== "admin" && role !== "member") {
      return res
        .status(400)
        .json({ message: 'role must be "admin" or "member"' });
    }

    // Cannot modify your own role
    if (requesterId === targetUserId) {
      return res
        .status(400)
        .json({ message: "You cannot change your own role" });
    }

    // Target must be a member
    const targetRecord = workspace.members.find(
      (m) => m.user.toString() === targetUserId,
    );
    if (!targetRecord) {
      return res
        .status(404)
        .json({ message: "User is not a member of this workspace" });
    }

    // Cannot change the owner's role
    if (targetRecord.role === "owner") {
      return res
        .status(400)
        .json({ message: "The workspace owner's role cannot be changed" });
    }

    await Workspace.findByIdAndUpdate(
      wsId,
      { $set: { "members.$[elem].role": role } },
      { arrayFilters: [{ "elem.user": targetUserId }] },
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${wsId}`).emit("workspace:role-updated", {
        workspaceId: wsId,
        targetUserId,
        newRole: role,
        by: requesterId,
      });
    }

    res.json({ message: "Role updated" });
  } catch (err) {
    console.error("updateMemberRole error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/leave
// Authenticated user voluntarily leaves the workspace.
// Special cases:
//   - Last member leaving: workspace is deleted entirely.
//   - Owner leaving with others remaining: ownership transfers to another
//     admin if one exists, otherwise to the longest-standing member.
// ---------------------------------------------------------------------------
exports.leaveWorkspace = async (req, res) => {
  try {
    const userId = req.user.id;
    const workspace = req.workspace;
    const wsId = workspace._id;
    const roomId = `workspace:${wsId}`;
    const io = req.app.get("io");

    const remainingMembers = workspace.members.filter(
      (m) => m.user.toString() !== userId,
    );

    // ── Last member — delete the workspace entirely ──────────────
    if (remainingMembers.length === 0) {
      if (io) {
        io.to(roomId).emit("workspace:deleted", {
          workspaceId: wsId,
          reason: "last_member_left",
        });
      }
      // Cascade delete all modules and their messages
      await ModuleMessage.deleteMany({ workspaceId: wsId });
      await Module.deleteMany({ workspaceId: wsId });
      await workspace.deleteOne();
      return res.json({
        message: "You were the last member; workspace has been deleted",
      });
    }

    const ownerRecord = workspace.members.find((m) => m.role === "owner");
    const isOwnerLeaving = ownerRecord?.user.toString() === userId;

    if (isOwnerLeaving) {
      // ── Owner leaving — transfer ownership ──────────────────────
      const nextAdmin = remainingMembers.find((m) => m.role === "admin");
      const newOwnerRecord = nextAdmin || remainingMembers[0];
      const newOwnerId = newOwnerRecord.user.toString();

      await Workspace.findByIdAndUpdate(
        wsId,
        {
          $pull: { members: { user: userId } },
          $set: { "members.$[elem].role": "owner" },
        },
        { arrayFilters: [{ "elem.user": newOwnerId }] },
      );

      if (io) {
        io.to(roomId).emit("workspace:owner-transferred", {
          workspaceId: wsId,
          newOwnerId,
          by: userId,
        });
      }
    } else {
      // ── Regular member or admin leaving ─────────────────────────
      await Workspace.findByIdAndUpdate(wsId, {
        $pull: { members: { user: userId } },
      });
    }

    if (io) {
      io.to(roomId).emit("workspace:member-left", {
        workspaceId: wsId,
        userId,
      });
    }

    res.json({ message: "You have left the workspace" });
  } catch (err) {
    console.error("leaveWorkspace error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/invite
// Generate a new invite link code for the workspace (admin+).
// Produces an 8-char alphanumeric code (Discord-style, ~48 bits entropy).
// Body: { expiresIn?: "30m"|"1h"|"6h"|"12h"|"1d"|"7d"|"never" }  (default: "never")
// ---------------------------------------------------------------------------
const INVITE_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const generateInviteCode = () =>
  Array.from(crypto.randomBytes(8))
    .map((b) => INVITE_CHARSET[b % INVITE_CHARSET.length])
    .join("");

const EXPIRY_DURATIONS = {
  "30m": 30 * 60 * 1000,
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 1 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  never: null,
};

exports.generateInvite = async (req, res) => {
  try {
    const wsId = req.workspace._id;
    const { expiresIn = "never" } = req.body || {};

    if (!(expiresIn in EXPIRY_DURATIONS)) {
      return res.status(400).json({
        message: "Invalid expiresIn. Use 30m, 1h, 6h, 12h, 1d, 7d, or never",
      });
    }

    const durationMs = EXPIRY_DURATIONS[expiresIn];
    const expiresAt = durationMs ? new Date(Date.now() + durationMs) : null;

    // Generate a unique 8-char alphanumeric code; retry up to 3 times on collision
    let code;
    let attempts = 0;
    while (attempts < 3) {
      const candidate = generateInviteCode();
      const collision = await Workspace.exists({ inviteCode: candidate });
      if (!collision) {
        code = candidate;
        break;
      }
      attempts++;
    }

    if (!code) {
      return res.status(500).json({
        message: "Failed to generate a unique invite code. Try again.",
      });
    }

    await Workspace.findByIdAndUpdate(wsId, {
      $set: { inviteCode: code, inviteCodeExpiresAt: expiresAt },
    });

    res.json({
      inviteCode: code,
      inviteUrl: `${process.env.SITE_URL}/invite/${code}`,
      expiresAt,
    });
  } catch (err) {
    console.error("generateInvite error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/join/:inviteCode
// Join a workspace via an invite code. No auth middleware on workspace needed —
// the invite code itself is the credential. Only requireAuth runs before this.
// ---------------------------------------------------------------------------
exports.getWorkspaceByInvite = async (req, res) => {
  try {
    const { inviteCode } = req.params;
    const workspace = await Workspace.findOne({ inviteCode })
      .select("name avatar description members inviteCodeExpiresAt")
      .populate("members.user", "name avatar");

    if (!workspace) {
      return res.status(404).json({ message: "Invalid or expired invite link" });
    }

    if (
      workspace.inviteCodeExpiresAt &&
      new Date() > workspace.inviteCodeExpiresAt
    ) {
      return res.status(410).json({ message: "This invite link has expired" });
    }

    const memberCount = workspace.members.length;
    res.status(200).json({
      _id: workspace._id,
      name: workspace.name,
      avatar: workspace.avatar,
      description: workspace.description,
      memberCount,
    });
  } catch (err) {
    console.error("getWorkspaceByInvite error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

exports.joinViaInvite = async (req, res) => {
  try {
    const { inviteCode } = req.params;
    const userId = req.user.id;

    const workspace = await Workspace.findOne({ inviteCode });
    if (!workspace) {
      return res
        .status(404)
        .json({ message: "Invalid or expired invite link" });
    }

    // Expiry check (null = never expires)
    if (
      workspace.inviteCodeExpiresAt &&
      new Date() > workspace.inviteCodeExpiresAt
    ) {
      return res.status(410).json({ message: "This invite link has expired" });
    }

    // Already a member?
    const alreadyMember = workspace.members.some(
      (m) => m.user.toString() === userId.toString(),
    );
    if (alreadyMember) {
      return res
        .status(400)
        .json({ message: "You are already a member of this workspace" });
    }

    // Member cap check
    if (workspace.members.length >= MAX_WORKSPACE_MEMBERS) {
      return res.status(400).json({
        message: `Workspace has reached the member limit (${MAX_WORKSPACE_MEMBERS})`,
      });
    }

    workspace.members.push({ user: userId, role: "member" });
    await workspace.save();

    await workspace.populate("createdBy", "name avatar");

    const io = req.app.get("io");
    io.to(`workspace:${workspace._id}`).emit("workspace:member-joined", {
      workspaceId: workspace._id,
      user: { _id: userId },
    });

    res.status(200).json({ ...workspace.toObject(), myRole: "member" });
  } catch (err) {
    console.error("joinViaInvite error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/invite
// Revoke the workspace invite link (admin+). Sets inviteCode to null so the
// old code stops working immediately.
// ---------------------------------------------------------------------------
exports.revokeInvite = async (req, res) => {
  try {
    await Workspace.findByIdAndUpdate(req.workspace._id, {
      $unset: { inviteCode: "", inviteCodeExpiresAt: "" },
    });

    res.json({ message: "Invite link revoked" });
  } catch (err) {
    console.error("revokeInvite error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/categories
// Add a new category to the workspace (admin+).
// Body: { name, position? }
// ---------------------------------------------------------------------------
exports.addCategory = async (req, res) => {
  try {
    const { name, position } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const trimmedName = name.trim();

    // Reject duplicate category names (case-insensitive)
    const duplicate = req.workspace.categories.some(
      (c) => c.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      return res
        .status(400)
        .json({ message: `Category "${trimmedName}" already exists` });
    }

    const newCategory = {
      name: trimmedName,
      ...(position !== undefined && { position }),
    };

    const updated = await Workspace.findByIdAndUpdate(
      req.workspace._id,
      { $push: { categories: newCategory } },
      { new: true, runValidators: true },
    );

    const added = updated.categories[updated.categories.length - 1];

    const io = req.app.get("io");
    io.to(`workspace:${updated._id}`).emit("workspace:category-added", {
      workspaceId: updated._id,
      category: added,
    });

    res.status(201).json(added);
  } catch (err) {
    console.error("addCategory error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/categories/:categoryId
// Update a category's name or position (admin+).
// Body: { name?, position? }
// ---------------------------------------------------------------------------
exports.updateCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { name, position } = req.body;

    if (name === undefined && position === undefined) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    // Verify the category exists on this workspace
    const category = req.workspace.categories.id(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const updateFields = {};
    if (name !== undefined) {
      if (!name.trim()) {
        return res
          .status(400)
          .json({ message: "Category name cannot be blank" });
      }
      updateFields["categories.$[cat].name"] = name.trim();
    }
    if (position !== undefined) {
      updateFields["categories.$[cat].position"] = position;
    }

    const updated = await Workspace.findByIdAndUpdate(
      req.workspace._id,
      { $set: updateFields },
      {
        returnDocument: 'after',
        arrayFilters: [{ "cat._id": category._id }],
        runValidators: true,
      },
    );

    const updatedCategory = updated.categories.id(categoryId);

    const io = req.app.get("io");
    io.to(`workspace:${updated._id}`).emit("workspace:category-updated", {
      workspaceId: updated._id,
      category: updatedCategory,
    });

    res.json(updatedCategory);
  } catch (err) {
    console.error("updateCategory error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/categories/:categoryId
// Remove a category from the workspace (admin+).
// ---------------------------------------------------------------------------
exports.deleteCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    // Verify the category exists on this workspace
    const category = req.workspace.categories.id(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    await Workspace.findByIdAndUpdate(req.workspace._id, {
      $pull: { categories: { _id: category._id } },
    });

    const io = req.app.get("io");
    io.to(`workspace:${req.workspace._id}`).emit("workspace:category-deleted", {
      workspaceId: req.workspace._id,
      categoryId,
    });

    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("deleteCategory error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/roles
// Create a custom role in the workspace (admin+).
// Body: { name, color?, permissions? }
// ---------------------------------------------------------------------------
exports.createRole = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { name, color, permissions } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Role name is required" });
    }
    const trimmedName = name.trim();

    const duplicate = workspace.roles?.some(
      (r) => r.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      return res.status(400).json({ message: `Role "${trimmedName}" already exists` });
    }

    const newRole = {
      name: trimmedName,
      color: color || "#5b5b8f",
      permissions: permissions || [],
    };

    const updated = await Workspace.findByIdAndUpdate(
      workspace._id,
      { $push: { roles: newRole } },
      { new: true, runValidators: true },
    );
    const addedRole = updated.roles[updated.roles.length - 1];

    const io = req.app.get("io");
    io.to(`workspace:${workspace._id}`).emit("workspace:role-created", {
      workspaceId: workspace._id,
      role: addedRole,
    });

    res.status(201).json(addedRole);
  } catch (err) {
    console.error("createRole error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/roles/:roleId
// Update a custom role's name, color, or permissions (admin+).
// ---------------------------------------------------------------------------
exports.updateRole = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { roleId } = req.params;
    const { name, color, permissions } = req.body;

    const role = workspace.roles?.id(roleId);
    if (!role) {
      return res.status(404).json({ message: "Role not found" });
    }

    const updateFields = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Role name cannot be blank" });
      const trimmedName = name.trim();
      const duplicate = workspace.roles?.some(
        (r) => r._id.toString() !== roleId && r.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (duplicate) {
        return res.status(400).json({ message: `Role "${trimmedName}" already exists` });
      }
      updateFields["roles.$[r].name"] = trimmedName;
    }
    if (color !== undefined) updateFields["roles.$[r].color"] = color;
    if (permissions !== undefined) updateFields["roles.$[r].permissions"] = permissions;

    const updated = await Workspace.findByIdAndUpdate(
      workspace._id,
      { $set: updateFields },
      { new: true, arrayFilters: [{ "r._id": role._id }] },
    );
    const updatedRole = updated.roles.id(roleId);

    const io = req.app.get("io");
    io.to(`workspace:${workspace._id}`).emit("workspace:role-updated-custom", {
      workspaceId: workspace._id,
      role: updatedRole,
    });

    res.json(updatedRole);
  } catch (err) {
    console.error("updateRole error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/roles/:roleId
// Delete a custom role from the workspace and strip it from members (admin+).
// ---------------------------------------------------------------------------
exports.deleteRole = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { roleId } = req.params;

    const role = workspace.roles?.id(roleId);
    if (!role) {
      return res.status(404).json({ message: "Role not found" });
    }

    // Remove role from workspace and strip from all members in one shot
    await Workspace.findByIdAndUpdate(workspace._id, {
      $pull: {
        roles: { _id: role._id },
        "members.$[].roleIds": role._id,
      },
    });

    const io = req.app.get("io");
    io.to(`workspace:${workspace._id}`).emit("workspace:role-deleted-custom", {
      workspaceId: workspace._id,
      roleId,
    });

    res.json({ message: "Role deleted" });
  } catch (err) {
    console.error("deleteRole error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/members/:targetUserId/roles
// Assign or remove custom role IDs for a member (admin+).
// Body: { roleIds: [...] }  — full replacement of the member's roleIds array
// ---------------------------------------------------------------------------
exports.assignRolesToMember = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { targetUserId } = req.params;
    const { roleIds } = req.body;

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ message: "roleIds array is required" });
    }

    const targetRecord = workspace.members.find(
      (m) => m.user.toString() === targetUserId,
    );
    if (!targetRecord) {
      return res.status(404).json({ message: "User is not a member of this workspace" });
    }

    // Validate that all roleIds exist in the workspace roles
    const validRoleIds = (workspace.roles || []).map((r) => r._id.toString());
    const invalid = roleIds.filter((id) => !validRoleIds.includes(id));
    if (invalid.length > 0) {
      return res.status(400).json({ message: "One or more role IDs are invalid" });
    }

    await Workspace.findByIdAndUpdate(
      workspace._id,
      { $set: { "members.$[elem].roleIds": roleIds } },
      { arrayFilters: [{ "elem.user": targetUserId }] },
    );

    const io = req.app.get("io");
    io.to(`workspace:${workspace._id}`).emit("workspace:member-roles-updated", {
      workspaceId: workspace._id,
      targetUserId,
      roleIds,
    });

    res.json({ message: "Roles updated" });
  } catch (err) {
    console.error("assignRolesToMember error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/join-public
// Join a public workspace directly (no invite code needed).
// ---------------------------------------------------------------------------
exports.joinPublicWorkspace = async (req, res) => {
  try {
    const userId = req.user.id;
    const workspace = await Workspace.findById(req.params.workspaceId);

    if (!workspace) {
      return res.status(404).json({ message: "Workspace not found" });
    }

    if (workspace.visibility !== "public") {
      return res.status(403).json({ message: "This workspace is not public" });
    }

    const alreadyMember = workspace.members.some(
      (m) => m.user.toString() === userId,
    );
    if (alreadyMember) {
      return res.status(400).json({ message: "You are already a member" });
    }

    if (workspace.members.length >= MAX_WORKSPACE_MEMBERS) {
      return res.status(400).json({
        message: `Workspace has reached the member limit (${MAX_WORKSPACE_MEMBERS})`,
      });
    }

    workspace.members.push({ user: userId, role: "member" });
    await workspace.save();
    await workspace.populate("createdBy", "name avatar");

    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("workspace:member-joined", {
        workspaceId: workspace._id,
        user: { _id: userId },
      });
    }

    res.status(200).json({ ...workspace.toObject(), myRole: "member" });
  } catch (err) {
    console.error("joinPublicWorkspace error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
