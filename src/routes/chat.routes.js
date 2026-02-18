const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const {
  getConversations,
  getMessages,
  createConversation,
  searchUsers,
} = require("../controllers/chat.controller");

// All routes require authentication
router.use(auth);

// @route   GET /api/chat/conversations
// @desc    Get all conversations for the logged-in user
router.get("/conversations", getConversations);

// @route   GET /api/chat/messages/:conversationId
// @desc    Get paginated message history for a conversation
router.get("/messages/:conversationId", getMessages);

// @route   POST /api/chat/conversations
// @desc    Create or return an existing conversation with another user
router.post("/conversations", createConversation);

// @route   GET /api/chat/users?q=<query>
// @desc    Search users by name or email
router.get("/users", searchUsers);

module.exports = router;
