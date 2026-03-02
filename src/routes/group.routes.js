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
  addMembers,
  removeMembers,
  promoteToAdmin,
  demoteAdmin,
  leaveGroup,
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
  isParticipant,
  isCreator,
  deleteGroup,
);

// @route   PATCH /api/chat/conversations/:id/members/add
// @desc    Add new members to a group
// @body    { userIds: [...] }
// @access  Group admins only
router.patch(
  "/conversations/:id/members/add",
  loadConversation,
  isGroupConversation,
  isParticipant,
  isAdmin,
  addMembers,
);

// @route   PATCH /api/chat/conversations/:id/members/remove
// @desc    Remove members from a group
// @body    { userIds: [...] }
// @access  Group admins only (creator can remove admins; admins can only remove non-admins)
router.patch(
  "/conversations/:id/members/remove",
  loadConversation,
  isGroupConversation,
  isParticipant,
  isAdmin,
  removeMembers,
);

// @route   PATCH /api/chat/conversations/:id/admins/add
// @desc    Promote a member to admin
// @body    { userId }
// @access  Group admins only
router.patch(
  "/conversations/:id/admins/add",
  loadConversation,
  isGroupConversation,
  isParticipant,
  isAdmin,
  promoteToAdmin,
);

// @route   PATCH /api/chat/conversations/:id/admins/remove
// @desc    Demote an admin to regular member
// @body    { userId }
// @access  Group creator only
router.patch(
  "/conversations/:id/admins/remove",
  loadConversation,
  isGroupConversation,
  isParticipant,
  isCreator,
  demoteAdmin,
);

// @route   POST /api/chat/conversations/:id/leave
// @desc    Leave a group (transfers ownership if creator)
// @access  Group participants only
router.post(
  "/conversations/:id/leave",
  loadConversation,
  isGroupConversation,
  isParticipant,
  leaveGroup,
);

module.exports = router;
