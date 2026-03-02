const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const {
  loadConversation,
  isGroupConversation,
  isParticipant,
  isAdmin,
  isCreator,
} = require("../middleware/group.middleware");

const {
  createGroup,
  getConversationDetails,
  updateGroupInfo,
  deleteGroup,
} = require("../controllers/group.controller");

// All routes require authentication
router.use(auth);

// @route   POST /api/chat/conversations/group
// @desc    Create a new group conversation
// @body    { name, participantIds: [...], avatar? }
// @access  Any authenticated user
router.post("/conversations/group", createGroup);

// @route   GET /api/chat/conversations/:id
// @desc    Get full details of a conversation (DM or group) the user belongs to
// @access  Participants only
router.get(
  "/conversations/:id",
  loadConversation,
  isParticipant,
  getConversationDetails,
);

// @route   PATCH /api/chat/conversations/:id/info
// @desc    Update group name and/or avatar
// @body    { name?, avatar? }
// @access  Group admins only
router.patch(
  "/conversations/:id/info",
  loadConversation,
  isGroupConversation,
  isParticipant,
  isAdmin,
  updateGroupInfo,
);

// @route   DELETE /api/chat/conversations/:id
// @desc    Permanently delete a group and all its messages
// @access  Group creator only
router.delete(
  "/conversations/:id",
  loadConversation,
  isGroupConversation,
  isCreator,
  deleteGroup,
);

module.exports = router;
