const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const User = require("../models/User");

// ──────────────────────────────────────────────────────────
// Mark message as read
// ──────────────────────────────────────────────────────────

exports.markMessageAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // Check membership
    const conversation = await Conversation.findById(message.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isMember = conversation.participants.some(
      (p) => p.toString() === userId,
    );

    if (!isMember) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    // Don't mark own messages as read
    if (message.sender.toString() === userId) {
      return res.json({ message: "Cannot mark own message as read" });
    }

    // Check if already marked
    const alreadyRead = message.readBy.some(
      (r) => r.user.toString() === userId,
    );

    if (alreadyRead) {
      return res.json({ message: "Already marked as read" });
    }

    // Add to readBy
    message.readBy.push({
      user: userId,
      readAt: new Date(),
    });

    await message.save();

    // Get user data for socket broadcast
    const reader = await User.findById(userId).select("name avatar");

    // ✅ FIX: Broadcast to ENTIRE conversation, not just sender
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${message.conversationId}`).emit("message:read-receipt", {
        messageId: message._id,
        conversationId: message.conversationId,
        reader: {
          _id: userId,
          name: reader?.name,
          avatar: reader?.avatar,
          readAt: message.readBy[message.readBy.length - 1].readAt,
        },
      });
    }

    res.json({
      message: "Marked as read",
      readBy: message.readBy,
    });
  } catch (err) {
    console.error("markMessageAsRead error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ──────────────────────────────────────────────────────────
// Bulk mark messages as read (when opening conversation)
// ──────────────────────────────────────────────────────────

exports.markMultipleAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { messageIds } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ message: "messageIds array required" });
    }

    // Verify membership
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isMember = conversation.participants.some(
      (p) => p.toString() === userId,
    );

    if (!isMember) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    // Bulk update messages
    const result = await Message.updateMany(
      {
        _id: { $in: messageIds },
        conversationId: conversationId,
        sender: { $ne: userId }, // Don't mark own messages
        "readBy.user": { $ne: userId }, // Not already read
      },
      {
        $push: {
          readBy: {
            user: userId,
            readAt: new Date(),
          },
        },
      },
    );

    // Get user data for socket broadcast
    const reader = await User.findById(userId).select("name avatar");

    // ✅ FIX: Already broadcasting to conversation (this is correct)
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("messages:bulk-read", {
        conversationId,
        messageIds,
        reader: {
          _id: userId,
          name: reader?.name,
          avatar: reader?.avatar,
          readAt: new Date(),
        },
      });
    }

    res.json({
      message: "Messages marked as read",
      count: result.modifiedCount,
    });
  } catch (err) {
    console.error("markMultipleAsRead error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
