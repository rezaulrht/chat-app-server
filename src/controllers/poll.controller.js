const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

// ──────────────────────────────────────────────────────────
// Create Poll
// ──────────────────────────────────────────────────────────

exports.createPoll = async (req, res) => {
  try {
    console.log("📊 POST /polls - Request received");
    console.log("Params:", req.params);
    console.log("Body:", req.body);
    console.log("User:", req.user?.id);
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { question, options, allowMultiple, expiresAt } = req.body;
   

    // ────────────────────────────────────────────────────────
    // Validation
    // ────────────────────────────────────────────────────────

    if (!question?.trim()) {
      return res.status(400).json({ message: "Poll question is required" });
    }

    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({
        message: "At least 2 options are required",
      });
      
    }

    if (options.length > 10) {
      return res.status(400).json({
        message: "Maximum 10 options allowed",
      });
      // ☝️ Too many options না হয় তার জন্য limit
    }

    // ────────────────────────────────────────────────────────
    // Check conversation exists and user is member
    // ────────────────────────────────────────────────────────

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

    // ────────────────────────────────────────────────────────
    // Format options with unique IDs
    // ────────────────────────────────────────────────────────

    const formattedOptions = options.map((opt, index) => ({
      id: `opt${index + 1}`,
      // ☝️ opt1, opt2, opt3... generate করছি
      text: opt.trim(),
      votes: [],
      // ☝️ Initially কোনো vote নেই
    }));

    // ────────────────────────────────────────────────────────
    // Parse expiry date (if provided)
    // ────────────────────────────────────────────────────────

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

    // ────────────────────────────────────────────────────────
    // Create poll message
    // ────────────────────────────────────────────────────────

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
    // ☝️ Frontend এ sender এর name/avatar দেখানোর জন্য

    // ────────────────────────────────────────────────────────
    // Update conversation lastMessage
    // ────────────────────────────────────────────────────────

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: {
        text: `📊 Poll: ${question.slice(0, 50)}${question.length > 50 ? "..." : ""}`,
        // ☝️ Conversation list এ preview text
        sender: userId,
        timestamp: pollMessage.createdAt,
      },
      updatedAt: pollMessage.createdAt,
    });

    // ────────────────────────────────────────────────────────
    // Socket broadcast to all participants
    // ────────────────────────────────────────────────────────

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("message:new", pollMessage);
      // ☝️ Group room এ সবাইকে পাঠাচ্ছি
    }

    res.status(201).json(pollMessage);
    // ☝️ 201 = Created
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
    // ☝️ Frontend থেকে পাচ্ছি: কোন option এ vote দিচ্ছে

    // ────────────────────────────────────────────────────────
    // Find poll message
    // ────────────────────────────────────────────────────────

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.poll) {
      return res.status(400).json({ message: "This is not a poll message" });
    }

    // ────────────────────────────────────────────────────────
    // Check if poll expired
    // ────────────────────────────────────────────────────────

    if (message.isPollExpired) {
      return res.status(400).json({ message: "This poll has expired" });
    }

    // ────────────────────────────────────────────────────────
    // Check if user is member
    // ────────────────────────────────────────────────────────

    const conversation = await Conversation.findById(message.conversationId);

    const isMember = conversation.participants.some(
      (p) => p.toString() === userId,
    );

    if (!isMember) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    // ────────────────────────────────────────────────────────
    // Find the option
    // ────────────────────────────────────────────────────────

    const option = message.poll.options.find((opt) => opt.id === optionId);

    if (!option) {
      return res.status(404).json({ message: "Option not found" });
    }

    // ────────────────────────────────────────────────────────
    // Check if user already voted
    // ────────────────────────────────────────────────────────

    const hasVotedThisOption = option.votes.some(
      (v) => v.toString() === userId,
    );

    if (hasVotedThisOption) {
      // Already voted on this option → Remove vote (toggle)
      option.votes = option.votes.filter((v) => v.toString() !== userId);
      // ☝️ User আবার same option এ click করলে vote remove হবে
    } else {
      // New vote

      if (!message.poll.allowMultiple) {
        // ────────────────────────────────────────────────────
        // Single choice: Remove votes from other options
        // ────────────────────────────────────────────────────

        message.poll.options.forEach((opt) => {
          opt.votes = opt.votes.filter((v) => v.toString() !== userId);
        });
        // ☝️ Radio button logic: শুধু একটা option select থাকবে
      }

      // Add vote to selected option
      option.votes.push(userId);
    }

    // ────────────────────────────────────────────────────────
    // Save changes
    // ────────────────────────────────────────────────────────

    await message.save();

    // Reload with populated data
    await message.populate("sender", "name avatar");
    await message.populate("poll.options.votes", "name avatar");
    // ☝️ Voters এর details populate করছি

    // ────────────────────────────────────────────────────────
    // Socket broadcast updated poll
    // ────────────────────────────────────────────────────────

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${message.conversationId}`).emit("poll:updated", {
        messageId: message._id,
        poll: message.poll,
        results: message.getPollResults(),
        // ☝️ Formatted results পাঠাচ্ছি
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
