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

    await workspace.populate({ path: "members.user", select: "name avatar email" });

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
      const memberRecord = ws.members.find(
        (m) => m.user.toString() === userId,
      );
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
