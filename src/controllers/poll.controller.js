const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

// ──────────────────────────────────────────────────────────
// Create Poll
// ──────────────────────────────────────────────────────────

exports.createPoll = async (req, res) => {
  try {
    // ✅ FIX: removed sensitive console logs, minimal log only
    console.log("POST /polls - request received");

    const userId = req.user.id;
    const { conversationId } = req.params;
    const { question, options, allowMultiple, expiresAt } = req.body;

    // Validation
    if (!question?.trim()) {
      return res.status(400).json({ message: "Poll question is required" });
    }

    // ✅ FIX: safe options validation (type + trim)
    if (!Array.isArray(options)) {
      return res.status(400).json({
        message: "Options must be an array",
      });
    }

    const cleanedOptions = [];

    for (const opt of options) {
      if (typeof opt !== "string") {
        return res.status(400).json({
          message: "Each option must be a string",
        });
      }

      const trimmed = opt.trim();

      if (!trimmed) {
        return res.status(400).json({
          message: "Options cannot be empty",
        });
      }

      cleanedOptions.push(trimmed);
    }

    if (cleanedOptions.length < 2) {
      return res.status(400).json({
        message: "At least 2 options are required",
      });
    }

    if (cleanedOptions.length > 10) {
      return res.status(400).json({
        message: "Maximum 10 options allowed",
      });
    }

    // Check conversation
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

    // Format options (use cleaned)
    const formattedOptions = cleanedOptions.map((opt, index) => ({
      id: `opt${index + 1}`,
      text: opt,
      votes: [],
    }));

    // Expiry
    let expiryDate = null;
    if (expiresAt) {
      expiryDate = new Date(expiresAt);

      if (isNaN(expiryDate.getTime())) {
        return res.status(400).json({ message: "Invalid expiry date" });
      }

      if (expiryDate <= new Date()) {
        return res.status(400).json({
          message: "Expiry date must be in the future",
        });
      }
    }

    const pollMessage = await Message.create({
      conversationId,
      sender: userId,
      poll: {
        question: question.trim(),
        options: formattedOptions,
        allowMultiple: !!allowMultiple,
        expiresAt: expiryDate,
        createdBy: userId,
      },
      status: "sent",
    });

    await pollMessage.populate("sender", "name avatar");

    // ✅ FIX: increment unreadCount for others
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: {
        text: `📊 Poll: ${question.slice(0, 50)}${
          question.length > 50 ? "..." : ""
        }`,
        sender: userId,
        timestamp: pollMessage.createdAt,
      },
      updatedAt: pollMessage.createdAt,
    });

    // separate update for unread count
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $inc: {
          "participants.$[elem].unreadCount": 1,
        },
      },
      {
        arrayFilters: [{ elem: { $ne: userId } }],
      },
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:new", pollMessage);
    }

    res.status(201).json(pollMessage);
  } catch (err) {
    console.error("createPoll error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ──────────────────────────────────────────────────────────
// Vote on Poll
// ──────────────────────────────────────────────────────────

exports.votePoll = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { optionId } = req.body;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.poll) {
      return res.status(400).json({ message: "This is not a poll message" });
    }

    if (message.isPollExpired) {
      return res.status(400).json({ message: "This poll has expired" });
    }

    const conversation = await Conversation.findById(message.conversationId);

    // ✅ FIX: null check before using participants
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

    const option = message.poll.options.find((opt) => opt.id === optionId);

    if (!option) {
      return res.status(404).json({ message: "Option not found" });
    }

    const hasVotedThisOption = option.votes.some(
      (v) => v.toString() === userId,
    );

    if (hasVotedThisOption) {
      option.votes = option.votes.filter((v) => v.toString() !== userId);
    } else {
      if (!message.poll.allowMultiple) {
        message.poll.options.forEach((opt) => {
          opt.votes = opt.votes.filter((v) => v.toString() !== userId);
        });
      }
      option.votes.push(userId);
    }

    await message.save();

    await message.populate("sender", "name avatar");
    await message.populate("poll.options.votes", "name avatar");

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${message.conversationId}`).emit("poll:updated", {
        messageId: message._id,
        poll: message.poll,
        results: message.getPollResults(),
      });
    }

    res.json({
      message: "Vote recorded",
      poll: message.poll,
      results: message.getPollResults(),
    });
  } catch (err) {
    console.error("votePoll error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ──────────────────────────────────────────────────────────
// Get Poll Results
// ──────────────────────────────────────────────────────────

exports.getPollResults = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await Message.findById(messageId)
      .populate("sender", "name avatar")
      .populate("poll.options.votes", "name avatar");

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.poll) {
      return res.status(400).json({ message: "This is not a poll message" });
    }

    // ✅ FIX: membership check before returning data
    const conversation = await Conversation.findById(message.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isMember = conversation.participants.some(
      (p) => p.toString() === req.user.id,
    );

    if (!isMember) {
      return res.status(403).json({
        message: "Forbidden: not a conversation member",
      });
    }

    res.json({
      poll: message.poll,
      results: message.getPollResults(),
      totalVotes: message.getTotalVotes(),
      isExpired: message.isPollExpired,
    });
  } catch (err) {
    console.error("getPollResults error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
