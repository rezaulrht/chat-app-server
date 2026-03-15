const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/messages/:messageId/pin
// Pin a message (admin-only for groups, anyone for DMs)
// ---------------------------------------------------------------------------
exports.pinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: conversationId, messageId } = req.params;
    const conversation = req.conversation; // from middleware

    // Verify message exists and belongs to this conversation
    const message = await Message.findOne({
      _id: messageId,
      conversationId: conversationId,
    });

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // // For groups, only admins can pin
    // if (conversation.type === "group") {
    //   const isAdmin = conversation.admins.some(
    //     (adminId) => adminId.toString() === userId,
    //   );
    //   if (!isAdmin) {
    //     return res
    //       .status(403)
    //       .json({ message: "Only admins can pin messages in groups" });
    //   }
    // }

    // Check if already pinned
    const alreadyPinned = conversation.pinnedMessages.some(
      (pm) => pm.messageId.toString() === messageId,
    );

    if (alreadyPinned) {
      return res.status(400).json({ message: "Message is already pinned" });
    }

    // Limit to 3 pinned messages (you can adjust this)
    if (conversation.pinnedMessages.length >= 3) {
      return res.status(400).json({
        message: "Maximum 3 messages can be pinned. Unpin one first.",
      });
    }

    // Add to pinned messages
    conversation.pinnedMessages.push({
      messageId: messageId,
      pinnedBy: userId,
      pinnedAt: new Date(),
    });

    await conversation.save();

    // Populate the message details for response
    await conversation.populate({
      path: "pinnedMessages.messageId",
      select: "text gifUrl sender createdAt",
      populate: { path: "sender", select: "name avatar" },
    });

    // Socket broadcast
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:pinned", {
        conversationId,
        pinnedMessages: conversation.pinnedMessages,
        pinnedBy: userId,
      });
    }

    res.json({
      message: "Message pinned successfully",
      pinnedMessages: conversation.pinnedMessages,
    });
  } catch (err) {
    console.error("pinMessage error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/chat/conversations/:id/messages/:messageId/pin
// Unpin a message
// ---------------------------------------------------------------------------
exports.unpinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: conversationId, messageId } = req.params;
    const conversation = req.conversation;

    // For groups, only admins can unpin
    if (conversation.type === "group") {
      const isAdmin = conversation.admins.some(
        (adminId) => adminId.toString() === userId,
      );
      if (!isAdmin) {
        return res
          .status(403)
          .json({ message: "Only admins can unpin messages in groups" });
      }
    }

    // Remove from pinned messages
    const initialLength = conversation.pinnedMessages.length;
    conversation.pinnedMessages = conversation.pinnedMessages.filter(
      (pm) => pm.messageId.toString() !== messageId,
    );

    if (conversation.pinnedMessages.length === initialLength) {
      return res.status(404).json({ message: "Message was not pinned" });
    }

    await conversation.save();

    // Populate remaining pinned messages
    await conversation.populate({
      path: "pinnedMessages.messageId",
      select: "text gifUrl sender createdAt",
      populate: { path: "sender", select: "name avatar" },
    });

    // Socket broadcast
    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:unpinned", {
        conversationId,
        messageId,
        pinnedMessages: conversation.pinnedMessages,
        unpinnedBy: userId,
      });
    }

    res.json({
      message: "Message unpinned successfully",
      pinnedMessages: conversation.pinnedMessages,
    });
  } catch (err) {
    console.error("unpinMessage error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/pins
// Get all pinned messages for a conversation
// ---------------------------------------------------------------------------
exports.getPinnedMessages = async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const conversation = req.conversation;

    await conversation.populate({
      path: "pinnedMessages.messageId",
      select: "text gifUrl sender createdAt reactions",
      populate: { path: "sender", select: "name avatar" },
    });

    res.json({
      conversationId,
      pinnedMessages: conversation.pinnedMessages,
    });
  } catch (err) {
    console.error("getPinnedMessages error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
