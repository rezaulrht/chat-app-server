const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth.middleware");
const {
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  isWorkspaceOwner,
} = require("../middleware/workspace.middleware");

const {
  createWorkspace,
  listMyWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addMembers,
  removeMembers,
  updateMemberRole,
  leaveWorkspace,
  generateInvite,
  joinViaInvite,
  revokeInvite,
  addCategory,
  updateCategory,
  deleteCategory,
} = require("../controllers/workspace.controller");

// All routes require authentication
router.use(auth);

module.exports = router;
