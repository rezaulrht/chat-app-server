const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

// ──────────────────────────────────────────────────────────
// Shared populate spec for pinned messages
// ──────────────────────────────────────────────────────────
const PINNED_MESSAGE_POPULATE = {
  path: "pinnedMessages.messageId",
  select: "text gifUrl sender createdAt",
  populate: { path: "sender", select: "name avatar" },
};

// ---------------------------------------------------------------------------
// PIN MESSAGE
// ---------------------------------------------------------------------------
exports.pinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: conversationId, messageId } = req.params;
    const conversation = req.conversation;

    const message = await Message.findOne({
      _id: messageId,
      conversationId,
    });

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // Admin check for groups
    if (conversation.type === "group") {
      const isAdmin = conversation.admins.some(
        (adminId) => adminId.toString() === userId,
      );
      if (!isAdmin) {
        return res
          .status(403)
          .json({ message: "Only admins can pin messages in groups" });
      }
    }

    // Atomic update
    const updatedConversation = await Conversation.findOneAndUpdate(
      {
        _id: conversation._id,
        "pinnedMessages.messageId": { $ne: messageId },
        $expr: { $lt: [{ $size: "$pinnedMessages" }, 3] },
      },
      {
        $push: {
          pinnedMessages: {
            messageId,
            pinnedBy: userId,
            pinnedAt: new Date(),
          },
        },
      },
      { new: true },
    );

    if (!updatedConversation) {
      const alreadyPinned = conversation.pinnedMessages.some(
        (pm) => pm.messageId.toString() === messageId,
      );

      if (alreadyPinned) {
        return res.status(400).json({ message: "Message is already pinned" });
      }

      return res
        .status(400)
        .json({ message: "Maximum 3 messages can be pinned" });
    }

    // ────────────────────────────────────────────────────────
    // Populate pinned messages using centralized spec
    // ────────────────────────────────────────────────────────
    await updatedConversation.populate(PINNED_MESSAGE_POPULATE);

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:pinned", {
        conversationId,
        pinnedMessages: updatedConversation.pinnedMessages,
        pinnedBy: userId,
      });
    }

    res.json({
      message: "Message pinned successfully",
      pinnedMessages: updatedConversation.pinnedMessages,
    });
  } catch (err) {
    console.error("pinMessage error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// UNPIN MESSAGE
// ---------------------------------------------------------------------------
exports.unpinMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: conversationId, messageId } = req.params;
    const conversation = req.conversation;

    // Admin check for groups
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

    // Atomic pull
    const updatedConversation = await Conversation.findOneAndUpdate(
      { _id: conversationId, "pinnedMessages.messageId": messageId },
      { $pull: { pinnedMessages: { messageId } } },
      { new: true },
    );

    if (!updatedConversation) {
      return res.status(404).json({ message: "Message was not pinned" });
    }

    await updatedConversation.populate(PINNED_MESSAGE_POPULATE);

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:unpinned", {
        conversationId,
        messageId,
        pinnedMessages: updatedConversation.pinnedMessages,
        unpinnedBy: userId,
      });
    }

    res.json({
      message: "Message unpinned successfully",
      pinnedMessages: updatedConversation.pinnedMessages,
    });
  } catch (err) {
    console.error("unpinMessage error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET PINNED MESSAGES
// ---------------------------------------------------------------------------
exports.getPinnedMessages = async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const conversation = req.conversation;

    await conversation.populate(PINNED_MESSAGE_POPULATE);

    res.json({
      conversationId,
      pinnedMessages: conversation.pinnedMessages,
    });
  } catch (err) {
    console.error("getPinnedMessages error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
