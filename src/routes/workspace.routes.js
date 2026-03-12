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

// ── Core workspace routes ─────────────────────────────────────────────────

// @route   POST /api/workspaces
// @desc    Create a new workspace
// @body    { name, description?, avatar?, visibility? }
// @access  Any authenticated user
router.post("/", createWorkspace);

// @route   GET /api/workspaces
// @desc    List all workspaces the caller is a member of
// @access  Any authenticated user
router.get("/", listMyWorkspaces);

// @route   POST /api/workspaces/join/:inviteCode
// @desc    Join a workspace via an invite code
// @access  Any authenticated user (must be before /:workspaceId routes)
router.post("/join/:inviteCode", joinViaInvite);

// @route   GET /api/workspaces/:workspaceId
// @desc    Get full details of a workspace the caller belongs to
// @access  Workspace members only
router.get(
  "/:workspaceId",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  getWorkspace,
);

// @route   PATCH /api/workspaces/:workspaceId
// @desc    Update workspace name, description, avatar, or visibility
// @body    { name?, description?, avatar?, visibility? }
// @access  Workspace admins and owner
router.patch(
  "/:workspaceId",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  updateWorkspace,
);

// @route   DELETE /api/workspaces/:workspaceId
// @desc    Permanently delete a workspace
// @access  Workspace owner only
router.delete(
  "/:workspaceId",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceOwner,
  deleteWorkspace,
);

// ── Member routes ─────────────────────────────────────────────────────────

// @route   POST /api/workspaces/:workspaceId/members
// @desc    Add one or more members to the workspace
// @body    { userIds: [...] }
// @access  Workspace admins and owner
router.post(
  "/:workspaceId/members",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  addMembers,
);

// @route   DELETE /api/workspaces/:workspaceId/members
// @desc    Remove one or more members from the workspace
// @body    { userIds: [...] }
// @access  Workspace admins and owner
router.delete(
  "/:workspaceId/members",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  removeMembers,
);

// @route   PATCH /api/workspaces/:workspaceId/members/:memberId/role
// @desc    Update a member's role (admin ↔ member)
// @body    { role: "admin" | "member" }
// @access  Workspace admins and owner
router.patch(
  "/:workspaceId/members/:memberId/role",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  updateMemberRole,
);

// @route   POST /api/workspaces/:workspaceId/leave
// @desc    Leave the workspace (owner triggers auto-transfer or deletion)
// @access  Any workspace member
router.post(
  "/:workspaceId/leave",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  leaveWorkspace,
);

// ── Invite routes ─────────────────────────────────────────────────────────

// @route   POST /api/workspaces/:workspaceId/invite
// @desc    Generate a new invite code (and optional expiry)
// @body    { expiresIn?: "30m"|"1h"|"6h"|"12h"|"1d"|"7d"|"never" }
// @access  Workspace admins and owner
router.post(
  "/:workspaceId/invite",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  generateInvite,
);

// @route   DELETE /api/workspaces/:workspaceId/invite
// @desc    Revoke the active invite link
// @access  Workspace admins and owner
router.delete(
  "/:workspaceId/invite",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  revokeInvite,
);

// ── Category routes ───────────────────────────────────────────────────────

// @route   POST /api/workspaces/:workspaceId/categories
// @desc    Add a new category to the workspace
// @body    { name, position? }
// @access  Workspace admins and owner
router.post(
  "/:workspaceId/categories",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  addCategory,
);

// @route   PATCH /api/workspaces/:workspaceId/categories/:categoryId
// @desc    Update a category's name or position
// @body    { name?, position? }
// @access  Workspace admins and owner
router.patch(
  "/:workspaceId/categories/:categoryId",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  updateCategory,
);

// @route   DELETE /api/workspaces/:workspaceId/categories/:categoryId
// @desc    Remove a category from the workspace
// @access  Workspace admins and owner
router.delete(
  "/:workspaceId/categories/:categoryId",
  validateWorkspaceId,
  loadWorkspace,
  isWorkspaceMember,
  isWorkspaceAdmin,
  deleteCategory,
);

module.exports = router;
