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
      // Check if user is currently online
      const isOnline = await redisClient.exists(`presence:${userId}`);
      
      if (isOnline) {
        // User is online
        result[userId] = { online: true, lastSeen: null };
      } else {
        // User is offline, get last seen time
        const lastSeenTimestamp = await redisClient.get(`lastSeen:${userId}`);
        result[userId] = { 
          online: false, 
          lastSeen: lastSeenTimestamp ? parseInt(lastSeenTimestamp) : null 
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error("getLastSeenBatch error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Search users by name or email (excludes the requesting user)
// @route   GET /api/chat/users?q=<query>
exports.searchUsers = async (req, res) => {
  try {
    const userId = req.user.id;
    const q = (req.query.q || "").trim();

    if (!q) {
      return res.json([]);
    }

    // Case-insensitive partial match on name OR email, exclude self
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

// @desc    Get all conversations for the logged-in user
// @route   GET /api/chat/conversations
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    const conversations = await Conversation.find({
      participants: userId,
    })
      .populate("participants", "name avatar email")
      .sort({ updatedAt: -1 });

    // Shape each conversation: expose the other participant and lastMessage
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

// @desc    Get paginated message history for a conversation
// @route   GET /api/chat/messages/:conversationId
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    // Verify the requesting user is a participant
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
      .populate("sender", "name avatar");

    // Return in chronological order (oldest first)
    res.json(messages.reverse());
  } catch (err) {
    console.error("getMessages error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create or return an existing conversation with another user
// @route   POST /api/chat/conversations
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

    // Check the target user exists
    const targetUser =
      await User.findById(participantId).select("name avatar email");
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Find existing conversation between these two users (order-independent)
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

    // Create new conversation
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
