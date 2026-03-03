/**
 * Group conversation permission middleware
 *
 * Chain these on group routes in order:
 *   loadConversation → isGroupConversation → isParticipant → isAdmin | isCreator
 *
 * Each middleware attaches req.conversation so downstream handlers
 * never need to re-query the database.
 */

const Conversation = require("../models/Conversation");

// ---------------------------------------------------------------------------
// loadConversation
// Fetches the conversation by req.params.id and attaches it to req.conversation.
// Must be the first middleware in every group route chain.
// ---------------------------------------------------------------------------
exports.loadConversation = async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    req.conversation = conversation;
    next();
  } catch (err) {
    // Malformed ObjectId or DB error
    console.error("loadConversation error:", err.message);
    res.status(400).json({ message: "Invalid conversation ID" });
  }
};

// ---------------------------------------------------------------------------
// isGroupConversation
// Blocks requests that target a DM conversation on group-only routes.
// Requires loadConversation to have run first.
// ---------------------------------------------------------------------------
exports.isGroupConversation = (req, res, next) => {
  if (req.conversation.type !== "group") {
    return res
      .status(400)
      .json({ message: "This action is only valid for group conversations" });
  }
  next();
};

// ---------------------------------------------------------------------------
// isParticipant
// Ensures the authenticated user is a member of the conversation.
// Requires loadConversation to have run first.
// ---------------------------------------------------------------------------
exports.isParticipant = (req, res, next) => {
  const userId = req.user.id;
  const isMember = req.conversation.participants.some(
    (p) => p.toString() === userId,
  );
  if (!isMember) {
    return res
      .status(403)
      .json({ message: "You are not a member of this conversation" });
  }
  next();
};

// ---------------------------------------------------------------------------
// isAdmin
// Ensures the authenticated user is an admin of the group.
// Requires loadConversation + isGroupConversation to have run first.
// ---------------------------------------------------------------------------
exports.isAdmin = (req, res, next) => {
  const userId = req.user.id;
  const isGroupAdmin = req.conversation.admins.some(
    (a) => a.toString() === userId,
  );
  if (!isGroupAdmin) {
    return res
      .status(403)
      .json({ message: "Only group admins can perform this action" });
  }
  next();
};

// ---------------------------------------------------------------------------
// isCreator
// Ensures the authenticated user is the original creator (owner) of the group.
// Only the creator can demote other admins, delete the group, etc.
// Requires loadConversation + isGroupConversation to have run first.
// ---------------------------------------------------------------------------
exports.isCreator = (req, res, next) => {
  const userId = req.user.id;
  if (req.conversation.createdBy?.toString() !== userId) {
    return res
      .status(403)
      .json({ message: "Only the group creator can perform this action" });
  }
  next();
};
