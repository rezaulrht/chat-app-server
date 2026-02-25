const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const {
  getConversations,
  getMessages,
  createConversation,
  searchUsers,
  getLastSeen,
  getLastSeenBatch,
  markConversationSeen,
  sendMessage,
  searchConversations,
} = require("../controllers/chat.controller");

// All routes require authentication
router.use(auth);

// @route   GET /api/chat/conversations
// @desc    Get all conversations for the logged-in user
router.get("/conversations", getConversations);

// @route   GET /api/chat/messages/:conversationId
// @desc    Get paginated message history for a conversation
router.get("/messages/:conversationId", getMessages);

// NEW ROUTE FOR SENDING MESSAGE (THREAD REPLY SUPPORT)
// @route   POST /api/chat/messages
// @desc    Send message (supports replyTo)
router.post("/messages", sendMessage);

// @route   POST /api/chat/conversations
// @desc    Create or return an existing conversation with another user
router.post("/conversations", createConversation);

// @route   GET /api/chat/users?q=<query>
// @desc    Search users by name or email
router.get("/users", searchUsers);

// @route   GET /api/chat/last-seen/:userId
// @desc    Get last seen time for a specific user
router.get("/last-seen/:userId", getLastSeen);

// @route   POST /api/chat/last-seen
// @desc    Get last seen times for multiple users
router.post("/last-seen", getLastSeenBatch);

// @route   POST /api/chat/:conversationId/seen
// @desc    Mark messages in a conversation as seen
// @body    { lastSeenMessageId: ObjectId }
router.post("/:conversationId/seen", markConversationSeen);
// GET /api/chat/search-conversations?q=keyword
router.get("/search-conversations", auth,searchConversations);
module.exports = router;
