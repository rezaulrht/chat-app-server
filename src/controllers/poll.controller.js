const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

// ──────────────────────────────────────────────────────────
// Create Poll
// ──────────────────────────────────────────────────────────

exports.createPoll = async (req, res) => {
  try {
    // ✅ Minimal, non-sensitive logging
    console.log("POST /polls - request received");

    const userId = req.user.id;
    const { conversationId } = req.params;
    const { question, options, allowMultiple, expiresAt } = req.body;

    // ──────────────────────────────────────────────────────────
    // Validation
    // ──────────────────────────────────────────────────────────

    if (!question?.trim()) {
      return res.status(400).json({ message: "Poll question is required" });
    }

    // ✅ Validate options is array
    if (!Array.isArray(options)) {
      return res.status(400).json({
        message: "Options must be an array",
      });
    }

    // ✅ Validate each option is a non-empty string
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

    // ──────────────────────────────────────────────────────────
    // Check conversation and membership
    // ──────────────────────────────────────────────────────────

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

    // ──────────────────────────────────────────────────────────
    // Format options with unique IDs
    // ──────────────────────────────────────────────────────────

    const formattedOptions = cleanedOptions.map((opt, index) => ({
      id: `opt${index + 1}`,
      text: opt,
      votes: [],
    }));

    // ──────────────────────────────────────────────────────────
    // Parse expiry date (if provided)
    // ──────────────────────────────────────────────────────────

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

    // ──────────────────────────────────────────────────────────
    // Create poll message
    // ──────────────────────────────────────────────────────────

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

    // Populate sender details
    await pollMessage.populate("sender", "name avatar");

    // ──────────────────────────────────────────────────────────
    // Update conversation lastMessage
    // ──────────────────────────────────────────────────────────

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

    // ──────────────────────────────────────────────────────────
    // Socket broadcast to all participants
    // ──────────────────────────────────────────────────────────

    const io = req.app.get("io");
    if (io) {
      try {
        // ✅ Convert to plain object to avoid circular references
        const pollData = pollMessage.toObject();

        console.log("Broadcasting poll to room:", `conv:${conversationId}`);
        io.to(`conv:${conversationId}`).emit("message:new", pollData);
      } catch (broadcastErr) {
        console.error("Socket broadcast error:", broadcastErr);
        // Don't fail the request - poll was created successfully
      }
    }

    // ──────────────────────────────────────────────────────────
    // Return response
    // ──────────────────────────────────────────────────────────

    res.status(201).json(pollMessage);
  } catch (err) {
    console.error("createPoll error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
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

    // ──────────────────────────────────────────────────────────
    // Load message
    // ──────────────────────────────────────────────────────────

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.poll) {
      return res.status(400).json({ message: "This is not a poll message" });
    }

    // ──────────────────────────────────────────────────────────
    // Check if poll expired
    // ──────────────────────────────────────────────────────────

    if (message.poll.expiresAt && new Date() > message.poll.expiresAt) {
      return res.status(400).json({ message: "This poll has expired" });
    }

    // ──────────────────────────────────────────────────────────
    // ✅ Load conversation and verify membership
    // ──────────────────────────────────────────────────────────

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

    // ──────────────────────────────────────────────────────────
    // Find the option
    // ──────────────────────────────────────────────────────────

    const option = message.poll.options.find((opt) => opt.id === optionId);

    if (!option) {
      return res.status(404).json({ message: "Option not found" });
    }

    // ──────────────────────────────────────────────────────────
    // Toggle vote
    // ──────────────────────────────────────────────────────────

    const hasVotedThisOption = option.votes.some(
      (v) => v.toString() === userId,
    );

    if (hasVotedThisOption) {
      // Remove vote (toggle)
      option.votes = option.votes.filter((v) => v.toString() !== userId);
    } else {
      // New vote
      if (!message.poll.allowMultiple) {
        // Remove votes from other options (single choice)
        message.poll.options.forEach((opt) => {
          opt.votes = opt.votes.filter((v) => v.toString() !== userId);
        });
      }
      option.votes.push(userId);
    }

    // ──────────────────────────────────────────────────────────
    // Save (mark modified for nested updates)
    // ──────────────────────────────────────────────────────────

    message.markModified("poll");
    await message.save();

    // Reload with populated data
    await message.populate("sender", "name avatar");
    await message.populate("poll.options.votes", "name avatar");

    // ──────────────────────────────────────────────────────────
    // Socket broadcast
    // ──────────────────────────────────────────────────────────

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${message.conversationId}`).emit("poll:updated", {
        messageId: message._id,
        poll: message.poll,
      });
    }

    res.json({
      message: "Vote recorded",
      poll: message.poll,
    });
  } catch (err) {
    console.error("votePoll error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ──────────────────────────────────────────────────────────
// Get Poll Results (with access control)
// ──────────────────────────────────────────────────────────

exports.getPollResults = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    // ──────────────────────────────────────────────────────────
    // Load message
    // ──────────────────────────────────────────────────────────

    const message = await Message.findById(messageId)
      .populate("sender", "name avatar")
      .populate("poll.options.votes", "name avatar");

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.poll) {
      return res.status(400).json({ message: "This is not a poll message" });
    }

    // ──────────────────────────────────────────────────────────
    // ✅ Verify user is a member of the conversation
    // ──────────────────────────────────────────────────────────

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

    // ──────────────────────────────────────────────────────────
    // Return results
    // ──────────────────────────────────────────────────────────

    res.json({
      poll: message.poll,
      results: message.getPollResults(),
      totalVotes: message.getTotalVotes(),
      isExpired: message.poll.expiresAt
        ? new Date() > message.poll.expiresAt
        : false,
    });
  } catch (err) {
    console.error("getPollResults error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
