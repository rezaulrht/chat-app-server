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
      categories: [],
      inviteCode: null,
    });

    await workspace.populate({
      path: "members.user",
      select: "name avatar email",
    });

    // ── Socket: emit to room (empty until Member 3's handler auto-joins) ──
    const io = req.app.get("io");
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("workspace:created", {
        workspace,
      });
    }

    res.status(201).json(workspace);
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
      };
    });

    res.json(result);
  } catch (err) {
    console.error("listMyWorkspaces error:", err.message);
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
    const { name, description, avatar, visibility } = req.body;
    const workspace = req.workspace; // attached by loadWorkspace

    // ── Require at least one field ───────────────────────────────
    if (
      name === undefined &&
      description === undefined &&
      avatar === undefined &&
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
        visibility: workspace.visibility,
      });
    }

    res.json({
      message: "Workspace updated",
      name: workspace.name,
      description: workspace.description,
      avatar: workspace.avatar,
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

    // TODO: delete workspace modules and messages (Member 2's domain)

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
