/**
 * Group conversation controller
 *
 * Handles: create, get details, update info, delete group,
 *          member management, admin promotion/demotion, leave group.
 *
 * Socket events emitted via req.app.get("io"):
 *   group:created         — broadcast to the new room after creation
 *   group:updated         — broadcast after name/avatar change
 *   group:deleted         — broadcast before deletion
 *   group:members-added   — broadcast when new members are added
 *   group:members-removed — broadcast when members are removed
 *   group:member-left     — broadcast when a member leaves voluntarily
 *   group:admin-updated   — broadcast when admin list changes
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
  if (!getIsRedisConnected()) {
    console.warn(
      `[joinSocketsToRoom] Redis unavailable — live socket join skipped for room ${roomId}. ` +
        "Affected users will auto-join on next connect via handler.js.",
    );
    return;
  }
  for (const userId of userIds) {
    try {
      const socketIds = await redisClient.sMembers(`sockets:${userId}`);
      for (const sid of socketIds) {
        const socket = io.sockets.sockets.get(sid);
        if (socket) socket.join(roomId);
      }
    } catch (err) {
      console.warn(
        `[joinSocketsToRoom] Failed to join sockets for user ${userId}:`,
        err.message,
      );
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
    const { name, description, participantIds, avatar } = req.body;
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
      description: description?.trim() || "", // ← ADD THIS
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
          description: conversation.description, // ← ADD THIS
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
      description: conversation.description,
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
      description: conversation.description,
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
    const { name, description, avatar } = req.body;
    const conversation = req.conversation;

    if (!name && avatar === undefined && description === undefined) {
      return res.status(400).json({
        message: "Provide name, description, and/or avatar to update",
      });
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

    if (description !== undefined) {
      if (description.trim().length > 500) {
        return res
          .status(400)
          .json({ message: "Description must be 500 characters or fewer" });
      }
      conversation.description = description.trim();
    }

    if (avatar !== undefined) {
      conversation.avatar = avatar || null;
    }

    await conversation.save();

    // Re-populate the conversation with all related fields
    await conversation.populate([
      { path: "participants", select: "name avatar email" },
      { path: "admins", select: "name avatar" },
      { path: "createdBy", select: "name avatar" },
    ]);

    // Notify all group members in real-time
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversation._id}`).emit("group:updated", {
        conversationId: conversation._id,
        name: conversation.name,
        description: conversation.description,
        avatar: conversation.avatar,
      });
    }

    // Return the FULL conversation object (not just selected fields)
    res.json({
      _id: conversation._id,
      type: conversation.type,
      name: conversation.name,
      description: conversation.description,
      avatar: conversation.avatar,
      createdBy: conversation.createdBy,
      admins: conversation.admins,
      participants: conversation.participants,
      lastMessage: conversation.lastMessage,
      updatedAt: conversation.updatedAt,
      createdAt: conversation.createdAt,
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

// ---------------------------------------------------------------------------
// Internal helper — force-leaves every active socket for a set of userIds
// from a Socket.io room.
// ---------------------------------------------------------------------------
const leaveSocketsFromRoom = async (io, userIds, roomId) => {
  if (!getIsRedisConnected()) {
    console.warn(
      `[leaveSocketsFromRoom] Redis unavailable — live socket leave skipped for room ${roomId}. ` +
        "Affected users will no longer receive room broadcasts once they reconnect.",
    );
    return;
  }
  for (const userId of userIds) {
    try {
      const socketIds = await redisClient.sMembers(`sockets:${userId}`);
      for (const sid of socketIds) {
        const socket = io.sockets.sockets.get(sid);
        if (socket) socket.leave(roomId);
      }
    } catch (err) {
      console.warn(
        `[leaveSocketsFromRoom] Failed to leave sockets for user ${userId}:`,
        err.message,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/chat/conversations/:id/members/add
// Add new members to a group (admin-only).
// Body: { userIds: [...] }
// ---------------------------------------------------------------------------
exports.addMembers = async (req, res) => {
  try {
    const { userIds } = req.body;
    const conversation = req.conversation;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "userIds array is required" });
    }

    const uniqueNewIds = [...new Set(userIds.map(String))];

    // Filter out users already in the group
    const existingIds = conversation.participants.map((p) => p.toString());
    const toAdd = uniqueNewIds.filter((id) => !existingIds.includes(id));

    if (toAdd.length === 0) {
      return res
        .status(400)
        .json({ message: "All provided users are already members" });
    }

    if (existingIds.length + toAdd.length > MAX_GROUP_SIZE) {
      return res.status(400).json({
        message: `Cannot exceed ${MAX_GROUP_SIZE} members. Current: ${existingIds.length}, trying to add: ${toAdd.length}`,
      });
    }

    // Verify all new IDs exist in the User collection
    const foundUsers = await User.find({ _id: { $in: toAdd } }).select(
      "_id name avatar email",
    );
    if (foundUsers.length !== toAdd.length) {
      return res
        .status(400)
        .json({ message: "One or more user IDs are invalid" });
    }

    // Build $inc entries to initialise unreadCount for new members
    const unreadInc = {};
    for (const id of toAdd) unreadInc[`unreadCount.${id}`] = 0;

    await Conversation.findByIdAndUpdate(conversation._id, {
      $addToSet: { participants: { $each: toAdd } },
      $set: unreadInc,
    });

    // Force-join new members' active sockets into the room
    const roomId = `conv:${conversation._id}`;
    const io = req.app.get("io");
    if (io) {
      await joinSocketsToRoom(io, toAdd, roomId);
      io.to(roomId).emit("group:members-added", {
        conversationId: conversation._id,
        addedBy: req.user.id,
        newMembers: foundUsers,
      });
    }

    // Fetch the updated conversation with populated fields
    const updatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name avatar email")
      .populate("admins", "name avatar")
      .populate("createdBy", "name avatar");

    res.json({
      _id: updatedConversation._id,
      type: "group",
      name: updatedConversation.name,
      description: updatedConversation.description,
      avatar: updatedConversation.avatar,
      createdBy: updatedConversation.createdBy,
      admins: updatedConversation.admins,
      participants: updatedConversation.participants,
      lastMessage: updatedConversation.lastMessage,
      updatedAt: updatedConversation.updatedAt,
      createdAt: updatedConversation.createdAt,
    });
  } catch (err) {
    console.error("addMembers error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/chat/conversations/:id/members/remove
// Remove members from a group (admin-only).
// Body: { userIds: [...] }
// Rules:
//   - Cannot remove createdBy (owner)
//   - Admins can remove non-admins;
//     only the creator can remove another admin
// ---------------------------------------------------------------------------
exports.removeMembers = async (req, res) => {
  try {
    const { userIds } = req.body;
    const conversation = req.conversation;
    const requesterId = req.user.id;
    const creatorId = conversation.createdBy.toString();

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "userIds array is required" });
    }

    const uniqueIds = [...new Set(userIds.map(String))];

    // Cannot remove the group creator/owner
    if (uniqueIds.includes(creatorId)) {
      return res
        .status(400)
        .json({ message: "The group creator cannot be removed" });
    }

    // Non-creator admins cannot remove other admins
    const adminIds = conversation.admins.map((a) => a.toString());
    if (requesterId !== creatorId) {
      const tryingToRemoveAdmin = uniqueIds.some((id) => adminIds.includes(id));
      if (tryingToRemoveAdmin) {
        return res
          .status(403)
          .json({ message: "Only the group creator can remove other admins" });
      }
    }

    // Ensure all targets are actually members
    const participantIds = conversation.participants.map((p) => p.toString());
    const validTargets = uniqueIds.filter((id) => participantIds.includes(id));
    if (validTargets.length === 0) {
      return res.status(400).json({
        message: "None of the provided users are members of this group",
      });
    }

    // Build $unset for each removed user's unreadCount entry
    const unsetFields = {};
    for (const id of validTargets) unsetFields[`unreadCount.${id}`] = "";

    await Conversation.findByIdAndUpdate(conversation._id, {
      $pull: {
        participants: { $in: validTargets },
        admins: { $in: validTargets },
        // Clean up per-user preference arrays
        pinnedBy: { $in: validTargets },
        archivedBy: { $in: validTargets },
        mutedBy: { $in: validTargets },
      },
      $unset: unsetFields,
    });

    // Force-leave removed members' sockets from the room
    const roomId = `conv:${conversation._id}`;
    const io = req.app.get("io");
    if (io) {
      await leaveSocketsFromRoom(io, validTargets, roomId);
      io.to(roomId).emit("group:members-removed", {
        conversationId: conversation._id,
        removedBy: requesterId,
        removedUserIds: validTargets,
      });
      // Notify removed members directly so their UI can react
      for (const userId of validTargets) {
        const socketIds = getIsRedisConnected()
          ? await redisClient.sMembers(`sockets:${userId}`).catch(() => [])
          : [];
        for (const sid of socketIds) {
          io.to(sid).emit("group:removed", {
            conversationId: conversation._id,
          });
        }
      }
    }

    // Fetch the updated conversation with populated fields
    const updatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name avatar email")
      .populate("admins", "name avatar")
      .populate("createdBy", "name avatar");

    res.json({
      _id: updatedConversation._id,
      type: "group",
      name: updatedConversation.name,
      description: updatedConversation.description,
      avatar: updatedConversation.avatar,
      createdBy: updatedConversation.createdBy,
      admins: updatedConversation.admins,
      participants: updatedConversation.participants,
      lastMessage: updatedConversation.lastMessage,
      updatedAt: updatedConversation.updatedAt,
      createdAt: updatedConversation.createdAt,
    });
  } catch (err) {
    console.error("removeMembers error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/chat/conversations/:id/admins/add
// Promote a member to admin (admin-only).
// Body: { userId }
// ---------------------------------------------------------------------------
exports.promoteToAdmin = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = req.conversation;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const participantIds = conversation.participants.map((p) => p.toString());
    if (!participantIds.includes(String(userId))) {
      return res
        .status(400)
        .json({ message: "User is not a member of this group" });
    }

    const adminIds = conversation.admins.map((a) => a.toString());
    if (adminIds.includes(String(userId))) {
      return res.status(400).json({ message: "User is already an admin" });
    }

    await Conversation.findByIdAndUpdate(conversation._id, {
      $addToSet: { admins: userId },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversation._id}`).emit("group:admin-updated", {
        conversationId: conversation._id,
        action: "promoted",
        userId,
        by: req.user.id,
      });
    }

    // Fetch the updated conversation with populated fields
    const updatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name avatar email")
      .populate("admins", "name avatar")
      .populate("createdBy", "name avatar");

    res.json({
      _id: updatedConversation._id,
      type: "group",
      name: updatedConversation.name,
      description: updatedConversation.description,
      avatar: updatedConversation.avatar,
      createdBy: updatedConversation.createdBy,
      admins: updatedConversation.admins,
      participants: updatedConversation.participants,
      lastMessage: updatedConversation.lastMessage,
      updatedAt: updatedConversation.updatedAt,
      createdAt: updatedConversation.createdAt,
    });
  } catch (err) {
    console.error("promoteToAdmin error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/chat/conversations/:id/admins/remove
// Demote an admin back to regular member (creator-only).
// Cannot demote the creator themselves.
// Body: { userId }
// ---------------------------------------------------------------------------
exports.demoteAdmin = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = req.conversation;
    const creatorId = conversation.createdBy.toString();

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    if (String(userId) === creatorId) {
      return res
        .status(400)
        .json({ message: "The group creator cannot be demoted" });
    }

    const adminIds = conversation.admins.map((a) => a.toString());
    if (!adminIds.includes(String(userId))) {
      return res.status(400).json({ message: "User is not an admin" });
    }

    await Conversation.findByIdAndUpdate(conversation._id, {
      $pull: { admins: userId },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversation._id}`).emit("group:admin-updated", {
        conversationId: conversation._id,
        action: "demoted",
        userId,
        by: req.user.id,
      });
    }

    // Fetch the updated conversation with populated fields
    const updatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name avatar email")
      .populate("admins", "name avatar")
      .populate("createdBy", "name avatar");

    res.json({
      _id: updatedConversation._id,
      type: "group",
      name: updatedConversation.name,
      description: updatedConversation.description,
      avatar: updatedConversation.avatar,
      createdBy: updatedConversation.createdBy,
      admins: updatedConversation.admins,
      participants: updatedConversation.participants,
      lastMessage: updatedConversation.lastMessage,
      updatedAt: updatedConversation.updatedAt,
      createdAt: updatedConversation.createdAt,
    });
  } catch (err) {
    console.error("demoteAdmin error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/leave
// Authenticated user voluntarily leaves the group.
// Special cases:
//   - If the leaving user is the creator, ownership transfers to the next
//     admin, or if no other admins exist, to the longest-standing participant.
//   - If the leaving user is the last member, group + messages are deleted.
// ---------------------------------------------------------------------------
exports.leaveGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const conversation = req.conversation;
    const creatorId = conversation.createdBy.toString();
    const roomId = `conv:${conversation._id}`;
    const io = req.app.get("io");

    const remainingParticipants = conversation.participants
      .map((p) => p.toString())
      .filter((id) => id !== userId);

    // Last member — delete the group entirely
    if (remainingParticipants.length === 0) {
      if (io) {
        io.to(roomId).emit("group:deleted", {
          conversationId: conversation._id,
          reason: "last_member_left",
        });
      }
      await Message.deleteMany({ conversationId: conversation._id });
      await conversation.deleteOne();
      return res.json({
        message: "You were the last member; group has been deleted",
      });
    }

    const updates = {
      $pull: {
        participants: userId,
        admins: userId,
        pinnedBy: userId,
        archivedBy: userId,
        mutedBy: userId,
      },
      $unset: { [`unreadCount.${userId}`]: "" },
    };

    // Transfer ownership if the creator is leaving
    if (userId === creatorId) {
      const otherAdmins = conversation.admins
        .map((a) => a.toString())
        .filter((id) => id !== userId);

      const newCreatorId =
        otherAdmins.length > 0
          ? otherAdmins[0] // promote next admin
          : remainingParticipants[0]; // fallback: oldest participant

      updates.$set = { createdBy: newCreatorId };
      updates.$addToSet = { admins: newCreatorId };
    }

    await Conversation.findByIdAndUpdate(conversation._id, updates);

    // Force-leave the departing user's sockets from the room
    if (io) {
      await leaveSocketsFromRoom(io, [userId], roomId);
      io.to(roomId).emit("group:member-left", {
        conversationId: conversation._id,
        userId,
        newCreatorId: updates.$set?.createdBy ?? null,
      });
    }

    res.json({ message: "You have left the group" });
  } catch (err) {
    console.error("leaveGroup error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
