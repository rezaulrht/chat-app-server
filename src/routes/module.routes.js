const express = require("express");
const router = express.Router({ mergeParams: true }); // ← mergeParams: true is critical
const auth = require("../middleware/auth.middleware");

const {
  createModule,
  listModules,
  getModule,
  updateModule,
  deleteModule,
  reorderModule,
  getModuleMessages,
  getThreadMessages,
  getPinnedMessages,
  searchModuleMessages,
  sendModuleMessage,
  markModuleSeen,
  editModuleMessage,
  deleteModuleMessage,
  reactToModuleMessage,
} = require("../controllers/module.controller");

router.use(auth);

// ── Module CRUD ──────────────────────────────────────────────────

// @route   POST /api/workspaces/:workspaceId/modules
// @desc    Create a new module in the workspace
// @body    { name, description?, type?, category?, position?, isPrivate? }
// @access  Workspace admins only
router.post("/", createModule);

// @route   GET /api/workspaces/:workspaceId/modules
// @desc    List all accessible modules in the workspace
// @access  Workspace members only
router.get("/", listModules);

// @route   GET /api/workspaces/:workspaceId/modules/:moduleId
// @desc    Get a single module's details
// @access  Workspace members (+ private module check)
router.get("/:moduleId", getModule);

// @route   PATCH /api/workspaces/:workspaceId/modules/:moduleId
// @desc    Update module name, description, type, category, or privacy
// @body    { name?, description?, type?, category?, isPrivate? }
// @access  Workspace admins only
router.patch("/:moduleId", updateModule);

// @route   DELETE /api/workspaces/:workspaceId/modules/:moduleId
// @desc    Delete module and all its messages
// @access  Workspace admins only
router.delete("/:moduleId", deleteModule);

// @route   PATCH /api/workspaces/:workspaceId/modules/:moduleId/position
// @desc    Reorder module within or between categories
// @body    { position, category? }
// @access  Workspace admins only
router.patch("/:moduleId/position", reorderModule);

// ── Module Messages ──────────────────────────────────────────────

// @route   GET /api/workspaces/:workspaceId/modules/:moduleId/messages
// @desc    Get paginated message history for a module
// @query   page (default 1), limit (default 30)
// @access  Workspace members (+ private module check)
router.get("/:moduleId/messages", getModuleMessages);

// @route   GET /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId/thread
// @desc    Get thread replies for a message
// @access  Workspace members 
router.get("/:moduleId/messages/:msgId/thread", getThreadMessages);

// @route   GET /api/workspaces/:workspaceId/modules/:moduleId/pinned
// @desc    Get pinned messages for a module
// @access  Workspace members 
router.get("/:moduleId/pinned", getPinnedMessages);

// @route   GET /api/workspaces/:workspaceId/modules/:moduleId/search
// @desc    Search for messages in a module based on text content
// @query   q (search snippet)
// @access  Workspace members
router.get("/:moduleId/search", searchModuleMessages);

// @route   POST /api/workspaces/:workspaceId/modules/:moduleId/messages
// @desc    Send a message in a module
// @body    { text?, gifUrl?, replyTo? }
// @access  Workspace members (announcement modules: admins only)
router.post("/:moduleId/messages", sendModuleMessage);

// @route   POST /api/workspaces/:workspaceId/modules/:moduleId/seen
// @desc    Mark module messages as seen by the current user
// @body    { lastSeenMessageId? }
// @access  Workspace members only
router.post("/:moduleId/seen", markModuleSeen);

// @route   PATCH /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId
// @desc    Edit a module message (sender only)
// @body    { text }
// @access  Message sender only
router.patch("/:moduleId/messages/:msgId", editModuleMessage);

// @route   DELETE /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId
// @desc    Delete a module message (soft delete)
// @query   forEveryone=true (admin/sender only)
// @access  Message sender or workspace admin
router.delete("/:moduleId/messages/:msgId", deleteModuleMessage);

// @route   POST /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId/react
// @desc    Toggle an emoji reaction on a module message
// @body    { emoji }
// @access  Workspace members only
router.post("/:moduleId/messages/:msgId/react", reactToModuleMessage);

module.exports = router;
