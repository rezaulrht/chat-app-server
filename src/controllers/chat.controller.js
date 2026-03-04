const User = require("../models/User");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { redisClient, getIsRedisConnected } = require("../config/redis");

// @desc    Get last seen time for a user
// @route   GET /api/chat/last-seen/:userId
exports.getLastSeen = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!getIsRedisConnected()) {
      return res.status(503).json({ message: "Service unavailable" });
    }

    const lastSeenTimestamp = await redisClient.get(`lastSeen:${userId}`);

    if (!lastSeenTimestamp) {
      return res.json({ userId, lastSeen: null });
    }

    res.json({ userId, lastSeen: parseInt(lastSeenTimestamp) });
  } catch (err) {
    console.error("getLastSeen error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get last seen times for multiple users
// @route   POST /api/chat/last-seen
exports.getLastSeenBatch = async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "userIds array is required" });
    }

    if (!getIsRedisConnected()) {
      return res.status(503).json({ message: "Service unavailable" });
    }

    const result = {};
    for (const userId of userIds) {
      const isOnline = await redisClient.exists(`presence:${userId}`);

      if (isOnline) {
        result[userId] = { online: true, lastSeen: null };
      } else {
        const lastSeenTimestamp = await redisClient.get(`lastSeen:${userId}`);
        result[userId] = {
          online: false,
          lastSeen: lastSeenTimestamp ? parseInt(lastSeenTimestamp) : null,
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error("getLastSeenBatch error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Search users
exports.searchUsers = async (req, res) => {
  try {
    const userId = req.user.id;
    const q = (req.query.q || "").trim();

    if (!q) return res.json([]);

    const users = await User.find({
      _id: { $ne: userId },
      $or: [
        { name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
      ],
    })
      .select("name email avatar")
      .limit(10);

    res.json(users);
  } catch (err) {
    console.error("searchUsers error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get all conversations
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    const conversations = await Conversation.find({
      participants: userId,
    })
      .populate("participants", "name avatar email")
      .populate("admins", "name avatar")
      .populate("createdBy", "name avatar")
      .sort({ updatedAt: -1 });

    const result = conversations.map((conv) => {
      const unreadCount = conv.unreadCount?.get(userId) || 0;
      const isPinned = conv.pinnedBy.some((id) => id.toString() === userId);
      const isArchived = conv.archivedBy.some((id) => id.toString() === userId);
      const isMuted = conv.mutedBy.some((id) => id.toString() === userId);

      // ── Group conversation ───────────────────────────────────────
      if (conv.type === "group") {
        return {
          _id: conv._id,
          type: "group",
          name: conv.name,
          avatar: conv.avatar,
          createdBy: conv.createdBy,
          admins: conv.admins,
          participants: conv.participants,
          lastMessage: conv.lastMessage,
          updatedAt: conv.updatedAt,
          unreadCount,
          isPinned,
          isArchived,
          isMuted,
        };
      }

      // ── DM conversation (existing shape + type field) ────────────
      const other = conv.participants.find((p) => p._id.toString() !== userId);
      return {
        _id: conv._id,
        type: "dm",
        participant: other,
        lastMessage: conv.lastMessage,
        updatedAt: conv.updatedAt,
        unreadCount,
        isPinned,
        isArchived,
        isMuted,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("getConversations error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get paginated messages (THREAD SUPPORT ADDED)
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    });

    if (!conversation) {
      return res
        .status(403)
        .json({ message: "Access denied to this conversation" });
    }

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "name avatar")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name avatar",
        },
      });

    res.json(messages.reverse());
  } catch (err) {
    console.error("getMessages error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// SEND MESSAGE WITH THREAD REPLY SUPPORT
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId, receiverId, text, replyTo } = req.body;

    if (!conversationId || !text) {
      return res.status(400).json({
        message: "conversationId and text are required",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    });

    if (!conversation) {
      return res.status(403).json({
        message: "Access denied to this conversation",
      });
    }

    const isGroup = conversation.type === "group";

    // DMs require a receiverId
    if (!isGroup && !receiverId) {
      return res
        .status(400)
        .json({ message: "receiverId is required for direct messages" });
    }

    // Reply validation
    if (replyTo) {
      const replyMessage = await Message.findOne({
        _id: replyTo,
        conversationId,
      });

      if (!replyMessage) {
        return res.status(400).json({
          message: "Invalid reply message",
        });
      }
    }

    const message = await Message.create({
      conversationId,
      sender: userId,
      receiverId: isGroup ? null : receiverId,
      text,
      replyTo: replyTo || null,
    });

    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name avatar")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name avatar",
        },
      });

    const lastMessage = {
      text,
      sender: userId,
      timestamp: populatedMessage.createdAt,
    };
    const inc = isGroup
      ? Object.fromEntries(
        conversation.participants
          .filter((p) => p.toString() !== userId)
          .map((p) => [`unreadCount.${p}`, 1]),
      )
      : { [`unreadCount.${receiverId}`]: 1 };

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage,
      $inc: inc,
    });

    res.status(201).json(populatedMessage);
  } catch (err) {
    console.error("sendMessage error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create or return conversation
exports.createConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { participantId } = req.body;

    if (!participantId) {
      return res.status(400).json({ message: "participantId is required" });
    }

    if (participantId === userId) {
      return res
        .status(400)
        .json({ message: "Cannot start a conversation with yourself" });
    }

    const targetUser =
      await User.findById(participantId).select("name avatar email");

    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let conversation = await Conversation.findOne({
      participants: { $all: [userId, participantId], $size: 2 },
    }).populate("participants", "name avatar email");

    if (conversation) {
      const other = conversation.participants.find(
        (p) => p._id.toString() !== userId,
      );

      const unreadCount = conversation.unreadCount?.get(userId) || 0;
      const isPinned = conversation.pinnedBy.some(
        (id) => id.toString() === userId,
      );
      const isArchived = conversation.archivedBy.some(
        (id) => id.toString() === userId,
      );
      const isMuted = conversation.mutedBy.some(
        (id) => id.toString() === userId,
      );

      return res.status(200).json({
        _id: conversation._id,
        participant: other,
        lastMessage: conversation.lastMessage,
        updatedAt: conversation.updatedAt,
        unreadCount,
        isPinned,
        isArchived,
        isMuted,
        existing: true,
      });
    }

    conversation = await Conversation.create({
      participants: [userId, participantId],
    });

    await conversation.populate("participants", "name avatar email");

    const other = conversation.participants.find(
      (p) => p._id.toString() !== userId,
    );

    res.status(201).json({
      _id: conversation._id,
      participant: other,
      lastMessage: conversation.lastMessage,
      updatedAt: conversation.updatedAt,
      unreadCount: 0,
      isPinned: false,
      isArchived: false,
      isMuted: false,
      existing: false,
    });
  } catch (err) {
    console.error("createConversation error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Mark messages as seen
exports.markConversationSeen = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { lastSeenMessageId } = req.body;

    if (!lastSeenMessageId) {
      return res.status(400).json({
        message: "lastSeenMessageId is required",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    });

    if (!conversation) {
      return res
        .status(403)
        .json({ message: "Access denied to this conversation" });
    }

    const lastSeenMessage = await Message.findOne({
      _id: lastSeenMessageId,
      conversationId,
    });

    if (!lastSeenMessage) {
      return res.status(404).json({
        message: "Message not found in this conversation",
      });
    }

    const result = await Message.updateMany(
      {
        conversationId,
        receiverId: userId,
        status: { $ne: "read" },
        createdAt: { $lte: lastSeenMessage.createdAt },
      },
      {
        $set: {
          status: "read",
          seenAt: new Date(),
        },
      },
    );

    // Reset unread count for this user atomically
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { [`unreadCount.${userId}`]: 0 },
    });

    res.json({
      message: "Messages marked as seen",
      modifiedCount: result.modifiedCount,
      upToMessageId: lastSeenMessageId,
    });
  } catch (err) {
    console.error("markConversationSeen error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
//   Search conversations by message text
exports.searchConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const keyword = q.trim();

    // Step 1: Get all conversation IDs for this user
    const userConvs = await Conversation.find({
      participants: userId,
    })
      .select("_id")
      .lean();

    const convIds = userConvs.map((c) => c._id);

    // Step 2: Find conversations where any message matches the keyword
    const matchingConvIds = await Message.distinct("conversationId", {
      conversationId: { $in: convIds },
      text: { $regex: keyword, $options: "i" },
    });

    // Step 3: Get the most recent matched message per conversation (to show in sidebar)
    const matchedMessages = await Message.aggregate([
      {
        $match: {
          conversationId: { $in: matchingConvIds },
          text: { $regex: keyword, $options: "i" },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          text: { $first: "$text" },
        },
      },
    ]);

    const matchedMsgMap = {};
    matchedMessages.forEach((m) => {
      matchedMsgMap[m._id.toString()] = m.text;
    });

    // Step 4: Fetch all conversations with participants populated for name/group-name matching
    const allUserConvs = await Conversation.find({
      _id: { $in: convIds },
      participants: userId,
    })
      .populate("participants", "name avatar email")
      .lean();

    const nameMatchIds = allUserConvs
      .filter((conv) => {
        if (conv.type === "group") {
          // Match by group name
          return conv.name?.toLowerCase().includes(keyword.toLowerCase());
        }
        // Match by DM participant name
        const other = conv.participants.find(
          (p) => p._id.toString() !== userId,
        );
        return other?.name?.toLowerCase().includes(keyword.toLowerCase());
      })
      .map((c) => c._id.toString());

    // Step 5: Merge message matches + name/group-name matches
    const allMatchIds = [
      ...new Set([
        ...matchingConvIds.map((id) => id.toString()),
        ...nameMatchIds,
      ]),
    ];

    // Step 6: Fetch full conversations and format same as getConversations
    const conversations = await Conversation.find({
      _id: { $in: allMatchIds },
      participants: userId,
    })
      .populate("participants", "name avatar email")
      .sort({ updatedAt: -1 })
      .lean();

    // Step 7: Format response — branch on type, include flags, show matched message text
    const result = conversations.map((conv) => {
      const matchedText = matchedMsgMap[conv._id.toString()];
      const lastMessage = matchedText
        ? { ...conv.lastMessage, text: matchedText }
        : conv.lastMessage;

      const unreadCount = conv.unreadCount?.[userId] || 0;
      const isPinned = (conv.pinnedBy || []).some(
        (id) => id.toString() === userId,
      );
      const isArchived = (conv.archivedBy || []).some(
        (id) => id.toString() === userId,
      );
      const isMuted = (conv.mutedBy || []).some(
        (id) => id.toString() === userId,
      );

      if (conv.type === "group") {
        return {
          _id: conv._id,
          type: "group",
          name: conv.name,
          avatar: conv.avatar,
          createdBy: conv.createdBy,
          admins: conv.admins,
          participants: conv.participants,
          lastMessage,
          updatedAt: conv.updatedAt,
          unreadCount,
          isPinned,
          isArchived,
          isMuted,
        };
      }

      const other = conv.participants.find((p) => p._id.toString() !== userId);
      return {
        _id: conv._id,
        type: "dm",
        participant: other,
        lastMessage,
        updatedAt: conv.updatedAt,
        unreadCount,
        isPinned,
        isArchived,
        isMuted,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("searchConversations error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Toggle pin conversation
// @route   PATCH /api/chat/conversations/:conversationId/pin
exports.togglePinConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // Check if already pinned by this user
    const existing = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    }).select("pinnedBy");

    if (!existing) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isPinned = existing.pinnedBy.some((id) => id.toString() === userId);

    // Use atomic $pull / $addToSet to avoid triggering the pre-validate hook
    await Conversation.updateOne(
      { _id: conversationId },
      isPinned
        ? { $pull: { pinnedBy: userId } }
        : { $addToSet: { pinnedBy: userId } },
    );

    res.json({
      message: isPinned ? "Conversation unpinned" : "Conversation pinned",
      isPinned: !isPinned,
    });
  } catch (err) {
    console.error("togglePinConversation error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Toggle archive conversation
// @route   PATCH /api/chat/conversations/:conversationId/archive
exports.toggleArchiveConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    const existing = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    }).select("archivedBy");

    if (!existing) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isArchived = existing.archivedBy.some(
      (id) => id.toString() === userId,
    );

    await Conversation.updateOne(
      { _id: conversationId },
      isArchived
        ? { $pull: { archivedBy: userId } }
        : { $addToSet: { archivedBy: userId } },
    );

    res.json({
      message: isArchived ? "Conversation unarchived" : "Conversation archived",
      isArchived: !isArchived,
    });
  } catch (err) {
    console.error("toggleArchiveConversation error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Toggle mute conversation
// @route   PATCH /api/chat/conversations/:conversationId/mute
exports.toggleMuteConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    const existing = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    }).select("mutedBy");

    if (!existing) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isMuted = existing.mutedBy.some((id) => id.toString() === userId);

    await Conversation.updateOne(
      { _id: conversationId },
      isMuted
        ? { $pull: { mutedBy: userId } }
        : { $addToSet: { mutedBy: userId } },
    );

    res.json({
      message: isMuted ? "Conversation unmuted" : "Conversation muted",
      isMuted: !isMuted,
    });
  } catch (err) {
    console.error("toggleMuteConversation error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
