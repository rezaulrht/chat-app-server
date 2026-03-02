/**
 * Group conversation controller
 *
 * Handles: create, get details, update info, delete group.
 * Member + admin management lives in steps 5 (addMembers, removeMembers, etc.)
 *
 * Socket events emitted via req.app.get("io"):
 *   group:created  — broadcast to the new room after creation
 *   group:updated  — broadcast after name/avatar change
 *   group:deleted  — broadcast before deletion
 */

const User = require("../models/User");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const { MAX_GROUP_SIZE } = require("../models/Conversation");

// ---------------------------------------------------------------------------
// Internal helper — force-joins every active socket for a set of userIds
// into a Socket.io room. Safe to call even when Redis is unavailable.
// ---------------------------------------------------------------------------
const joinSocketsToRoom = async (io, userIds, roomId) => {
  if (!getIsRedisConnected()) return;
  for (const userId of userIds) {
    try {
      const socketIds = await redisClient.sMembers(`sockets:${userId}`);
      for (const sid of socketIds) {
        const socket = io.sockets.sockets.get(sid);
        if (socket) socket.join(roomId);
      }
    } catch (_) {
      // Non-fatal — user will auto-join on next connect via handler.js
    }
  }
};

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/group
// Create a new group conversation.
// Body: { name, participantIds: [...], avatar? }
// ---------------------------------------------------------------------------
exports.createGroup = async (req, res) => {
  try {
    const creatorId = req.user.id;
    const { name, participantIds, avatar } = req.body;

    // ── Validate name ────────────────────────────────────────────
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Group name is required" });
    }
    if (name.trim().length > 100) {
      return res
        .status(400)
        .json({ message: "Group name must be 100 characters or fewer" });
    }

    // ── Validate participantIds ──────────────────────────────────
    if (!Array.isArray(participantIds) || participantIds.length < 2) {
      return res.status(400).json({
        message:
          "At least 2 other participants are required (3 total including you)",
      });
    }

    // Strip duplicates and remove the creator if accidentally included
    const uniqueOtherIds = [
      ...new Set(participantIds.map(String).filter((id) => id !== creatorId)),
    ];

    if (uniqueOtherIds.length < 2) {
      return res.status(400).json({
        message:
          "At least 2 other participants are required (3 total including you)",
      });
    }

    const totalCount = uniqueOtherIds.length + 1; // +1 for creator
    if (totalCount > MAX_GROUP_SIZE) {
      return res.status(400).json({
        message: `Groups cannot exceed ${MAX_GROUP_SIZE} members`,
      });
    }

    // Verify all participant IDs actually exist
    const foundUsers = await User.find({ _id: { $in: uniqueOtherIds } }).select(
      "_id",
    );
    if (foundUsers.length !== uniqueOtherIds.length) {
      return res
        .status(400)
        .json({ message: "One or more participant IDs are invalid" });
    }

    const allParticipantIds = [creatorId, ...uniqueOtherIds];

    // ── Build initial unreadCount map (0 for everyone) ──────────
    const initialUnread = {};
    for (const id of allParticipantIds) {
      initialUnread[id] = 0;
    }

    // ── Create the conversation ──────────────────────────────────
    const conversation = await Conversation.create({
      type: "group",
      name: name.trim(),
      avatar: avatar || null,
      createdBy: creatorId,
      admins: [creatorId],
      participants: allParticipantIds,
      unreadCount: initialUnread,
    });

    await conversation.populate([
      { path: "participants", select: "name avatar email" },
      { path: "admins", select: "name avatar" },
      { path: "createdBy", select: "name avatar" },
    ]);

    // ── Socket: force-join all participants into the room ────────
    const roomId = `conv:${conversation._id}`;
    const io = req.app.get("io");
    if (io) {
      await joinSocketsToRoom(io, allParticipantIds, roomId);
      io.to(roomId).emit("group:created", {
        conversation: {
          _id: conversation._id,
          type: "group",
          name: conversation.name,
          avatar: conversation.avatar,
          createdBy: conversation.createdBy,
          admins: conversation.admins,
          participants: conversation.participants,
          lastMessage: conversation.lastMessage,
          updatedAt: conversation.updatedAt,
        },
      });
    }

    res.status(201).json({
      _id: conversation._id,
      type: "group",
      name: conversation.name,
      avatar: conversation.avatar,
      createdBy: conversation.createdBy,
      admins: conversation.admins,
      participants: conversation.participants,
      lastMessage: conversation.lastMessage,
      unreadCount: 0,
      isPinned: false,
      isArchived: false,
      isMuted: false,
      updatedAt: conversation.updatedAt,
      createdAt: conversation.createdAt,
    });
  } catch (err) {
    console.error("createGroup error:", err.message);
    // Surface pre-validate hook errors (e.g. < 3 participants) as 400
    if (err.message.includes("Group conversations")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id
// Fetch full details of any conversation the authenticated user belongs to.
// Works for both DMs and groups; req.conversation set by loadConversation.
// ---------------------------------------------------------------------------
exports.getConversationDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const conversation = req.conversation; // attached by loadConversation middleware

    await conversation.populate([
      { path: "participants", select: "name avatar email" },
      { path: "admins", select: "name avatar" },
      { path: "createdBy", select: "name avatar" },
    ]);

    const isPinned = conversation.pinnedBy.some(
      (id) => id.toString() === userId,
    );
    const isArchived = conversation.archivedBy.some(
      (id) => id.toString() === userId,
    );
    const isMuted = conversation.mutedBy.some((id) => id.toString() === userId);
    const unreadCount = conversation.unreadCount?.get(userId) || 0;

    if (conversation.type === "dm") {
      const other = conversation.participants.find(
        (p) => p._id.toString() !== userId,
      );
      return res.json({
        _id: conversation._id,
        type: "dm",
        participant: other,
        lastMessage: conversation.lastMessage,
        unreadCount,
        isPinned,
        isArchived,
        isMuted,
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
      });
    }

    res.json({
      _id: conversation._id,
      type: "group",
      name: conversation.name,
      avatar: conversation.avatar,
      createdBy: conversation.createdBy,
      admins: conversation.admins,
      participants: conversation.participants,
      lastMessage: conversation.lastMessage,
      unreadCount,
      isPinned,
      isArchived,
      isMuted,
      updatedAt: conversation.updatedAt,
      createdAt: conversation.createdAt,
    });
  } catch (err) {
    console.error("getConversationDetails error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/chat/conversations/:id/info
// Update group name and/or avatar (admin-only).
// Body: { name?, avatar? }
// ---------------------------------------------------------------------------
exports.updateGroupInfo = async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const conversation = req.conversation; // attached by loadConversation middleware

    if (!name && avatar === undefined) {
      return res
        .status(400)
        .json({ message: "Provide name and/or avatar to update" });
    }

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: "Group name cannot be empty" });
      }
      if (name.trim().length > 100) {
        return res
          .status(400)
          .json({ message: "Group name must be 100 characters or fewer" });
      }
      conversation.name = name.trim();
    }

    if (avatar !== undefined) {
      conversation.avatar = avatar || null;
    }

    await conversation.save();

    // Notify all group members in real-time
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversation._id}`).emit("group:updated", {
        conversationId: conversation._id,
        name: conversation.name,
        avatar: conversation.avatar,
      });
    }

    res.json({
      message: "Group updated successfully",
      name: conversation.name,
      avatar: conversation.avatar,
    });
  } catch (err) {
    console.error("updateGroupInfo error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/chat/conversations/:id
// Permanently delete a group and all its messages (creator-only).
// ---------------------------------------------------------------------------
exports.deleteGroup = async (req, res) => {
  try {
    const conversation = req.conversation; // attached by loadConversation middleware
    const conversationId = conversation._id;

    // Notify all members before deletion so clients can close the conversation UI
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("group:deleted", {
        conversationId,
        deletedBy: req.user.id,
      });
    }

    // Delete all messages in the conversation, then the conversation itself
    await Message.deleteMany({ conversationId });
    await conversation.deleteOne();

    res.json({ message: "Group deleted successfully" });
  } catch (err) {
    console.error("deleteGroup error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
