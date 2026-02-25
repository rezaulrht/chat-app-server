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
      .sort({ updatedAt: -1 });

    const result = conversations.map((conv) => {
      const other = conv.participants.find((p) => p._id.toString() !== userId);
      return {
        _id: conv._id,
        participant: other,
        lastMessage: conv.lastMessage,
        updatedAt: conv.updatedAt,
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

    if (!conversationId || !receiverId || !text) {
      return res.status(400).json({
        message: "conversationId, receiverId and text are required",
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
      receiverId,
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

    conversation.lastMessage = {
      text,
      sender: userId,
      timestamp: populatedMessage.createdAt,
    };
    await conversation.save();

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
      return res.status(200).json({
        _id: conversation._id,
        participant: other,
        lastMessage: conversation.lastMessage,
        updatedAt: conversation.updatedAt,
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

    // Step 4: Also find conversations matching by participant name
    const allUserConvs = await Conversation.find({
      _id: { $in: convIds },
      participants: userId,
    })
      .populate("participants", "name avatar email")
      .lean();

    const nameMatchIds = allUserConvs
      .filter((conv) => {
        const other = conv.participants.find(
          (p) => p._id.toString() !== userId,
        );
        return other?.name?.toLowerCase().includes(keyword.toLowerCase());
      })
      .map((c) => c._id.toString());

    // Step 5: Merge message matches + name matches
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

    // Step 7: Format response — show matched message text instead of lastMessage
    const result = conversations.map((conv) => {
      const other = conv.participants.find((p) => p._id.toString() !== userId);
      const matchedText = matchedMsgMap[conv._id.toString()];
      return {
        _id: conv._id,
        participant: other,
        lastMessage: matchedText
          ? { ...conv.lastMessage, text: matchedText } // ✅ show the matched message
          : conv.lastMessage,
        updatedAt: conv.updatedAt,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("searchConversations error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};