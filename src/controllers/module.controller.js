/**
 * Module controller
 *
 * Handles: create module, list modules, get module, update module, delete module,
 *          module position reorder, get messages, send message, mark seen,
 *          edit message, delete message, react to message.
 *
 * All socket events are emitted via req.app.get("io").
 * Workspace room: workspace:<workspaceId>
 * Module room:    module:<moduleId>
 *
 * Socket events emitted:
 *   module:created         — broadcast to workspace:<workspaceId> after creation
 *   module:updated         — broadcast to workspace:<workspaceId> after update
 *   module:deleted         — broadcast to workspace:<workspaceId> before deletion
 *   module:message:new     — broadcast to module:<moduleId> after send
 *   module:message:edited  — broadcast to module:<moduleId> after edit
 *   module:message:deleted — broadcast to module:<moduleId> after delete-for-everyone
 *   module:message:reacted — broadcast to module:<moduleId> after react toggle
 *   module:message:status  — broadcast to module:<moduleId> after mark-seen
 */

const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");
const Module = require("../models/Module");
const ModuleMessage = require("../models/ModuleMessage");
const NotificationService = require("../services/notification.service");
const createHelpers = require("../socket/helpers");

// ---------------------------------------------------------------------------
// Internal helper — inline workspace membership check
// Returns { workspace, memberRecord } or sends an error response.
// ---------------------------------------------------------------------------
const checkMembership = async (res, workspaceId, userId) => {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) {
    res.status(404).json({ message: "Workspace not found" });
    return null;
  }
  const memberRecord = workspace.members.find(
    (m) => m.user.toString() === userId,
  );
  if (!memberRecord) {
    res.status(403).json({ message: "Access denied to this workspace" });
    return null;
  }
  return { workspace, memberRecord };
};

// ---------------------------------------------------------------------------
// Internal helper — Compute permissions for a member in a specific module
// Evaluates workspace base roles + module-specific permission overrides.
// ---------------------------------------------------------------------------
const computePermissions = (workspace, memberRecord, module) => {
  const { PERMISSIONS } = Workspace;
  const isOwner = memberRecord.role === "owner";

  // Default permissions if they have no custom roles
  const basePerms = new Set();

  if (isOwner) {
    // Owners have everything natively
    Object.values(PERMISSIONS).forEach((p) => basePerms.add(p));
    return basePerms;
  }

  // 1. Gather all base permissions from the user's roles
  if (memberRecord.roleIds && memberRecord.roleIds.length > 0) {
    const roleIdsStr = memberRecord.roleIds.map(String);
    const userRoles = workspace.roles.filter((r) =>
      roleIdsStr.includes(r._id.toString()),
    );

    userRoles.forEach((role) => {
      role.permissions?.forEach((p) => basePerms.add(p));
    });
  } else if (memberRecord.role === "admin") {
    // Legacy support for pure 'admin' string role
    basePerms.add(PERMISSIONS.ADMINISTRATOR);
  } else {
    // Default member fallback (if no roles are assigned at all)
    // They can view channels and send messages by default
    basePerms.add(PERMISSIONS.VIEW_CHANNEL);
    basePerms.add(PERMISSIONS.SEND_MESSAGES);
  }

  // Administrators bypass all overrides
  if (basePerms.has(PERMISSIONS.ADMINISTRATOR)) {
    Object.values(PERMISSIONS).forEach((p) => basePerms.add(p));
    return basePerms;
  }

  // 2. Apply module-specific Permission Overrides if they exist
  if (
    module &&
    module.permissionOverrides &&
    module.permissionOverrides.length > 0
  ) {
    const roleIdStrings = memberRecord.roleIds?.map(String) || [];

    // a. Apply role-based overrides first
    const roleOverrides = module.permissionOverrides.filter(
      (ov) =>
        ov.targetType === "role" &&
        roleIdStrings.includes(ov.targetId.toString()),
    );

    const denyRoles = new Set();
    const allowRoles = new Set();

    roleOverrides.forEach((ov) => {
      ov.deny?.forEach((p) => denyRoles.add(p));
      ov.allow?.forEach((p) => allowRoles.add(p));
    });

    // Remove denied, add allowed
    denyRoles.forEach((p) => basePerms.delete(p));
    allowRoles.forEach((p) => basePerms.add(p));

    // b. Apply member-based overrides (takes precedence over roles)
    const memberOverride = module.permissionOverrides.find(
      (ov) =>
        ov.targetType === "member" &&
        ov.targetId.toString() === memberRecord.user.toString(),
    );

    if (memberOverride) {
      memberOverride.deny?.forEach((p) => basePerms.delete(p));
      memberOverride.allow?.forEach((p) => basePerms.add(p));
    }
  }

  return basePerms;
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/modules
// Create a new module in the workspace (admin/owner only).
// Body: { name, description?, type?, category?, position?, isPrivate? }
// ---------------------------------------------------------------------------
exports.createModule = async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // ── 1. Validate workspaceId ──────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }

    // ── 2. Inline membership check (admin/owner required) ────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";
    if (!isAdmin) {
      return res
        .status(403)
        .json({ message: "Only workspace admins can perform this action" });
    }

    // ── 3. Validate name ─────────────────────────────────────────
    const {
      name,
      description,
      type,
      category,
      position,
      isPrivate,
      permissionOverrides,
    } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Module name is required" });
    }
    if (name.trim().length > 100) {
      return res
        .status(400)
        .json({ message: "Module name must be 100 characters or fewer" });
    }

    // ── 4. Validate type ─────────────────────────────────────────
    const validTypes = ["text", "announcement", "voice"];
    const moduleType = type || "text";
    if (!validTypes.includes(moduleType)) {
      return res
        .status(400)
        .json({ message: "Type must be 'text', 'announcement', or 'voice'" });
    }

    // ── 5. Validate category ─────────────────────────────────────
    let resolvedCategory = null;
    if (category) {
      const categoryExists = workspace.categories?.some(
        (c) => c.name === category || c === category,
      );
      if (!categoryExists) {
        return res
          .status(400)
          .json({ message: "Category not found in this workspace" });
      }
      resolvedCategory = category;
    }

    // ── 6. Default position ──────────────────────────────────────
    const resolvedPosition =
      position !== undefined
        ? position
        : await Module.countDocuments({
            workspaceId,
            category: resolvedCategory,
          });

    // ── 7. Create module ─────────────────────────────────────────
    const module = await Module.create({
      workspaceId,
      name: name.trim(),
      description: description?.trim() || null,
      type: moduleType,
      category: resolvedCategory,
      position: resolvedPosition,
      isPrivate: isPrivate || false,
      permissionOverrides: permissionOverrides || [],
      createdBy: req.user.id,
    });

    // ── 8. Populate createdBy ────────────────────────────────────
    await module.populate("createdBy", "name avatar");

    // ── 9. Emit socket event ─────────────────────────────────────
    const io = req.app.get("io");
    io.to(`workspace:${workspaceId}`).emit("module:created", { module });

    // ── 10. Respond ──────────────────────────────────────────────
    return res.status(201).json(module);
  } catch (err) {
    console.error("createModule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules
// List all accessible modules in the workspace.
// ---------------------------------------------------------------------------
exports.listModules = async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // ── 1. Validate workspaceId ──────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 3. Fetch and sort modules ────────────────────────────────
    const modules = await Module.find({ workspaceId })
      .populate("activeParticipants.userId", "name avatar")
      .sort({
        category: 1,
        position: 1,
      });

    // ── 4 & 5. Filter private + inject myUnread ──────────────────
    const accessible = modules
      .filter((m) => {
        const perms = computePermissions(workspace, memberRecord, m);
        return perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL);
      })
      .map((m) => {
        const obj = m.toObject();
        obj.myUnread = m.unreadCount?.get(req.user.id) || 0;
        return obj;
      });

    return res.json(accessible);
  } catch (err) {
    console.error("listModules error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId
// Get a single module's details.
// ---------------------------------------------------------------------------
exports.getModule = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 3. Fetch module ──────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 4. Private module check ──────────────────────────────────
    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied to this module" });
    }

    // ── 5. Populate createdBy ────────────────────────────────────
    await module.populate("createdBy", "name avatar");

    // ── 6. Inject myUnread ───────────────────────────────────────
    const obj = module.toObject();
    obj.myUnread = module.unreadCount?.get(req.user.id) || 0;

    return res.json(obj);
  } catch (err) {
    console.error("getModule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/modules/:moduleId
// Update module name, description, type, category, or privacy.
// Body: { name?, description?, type?, category?, isPrivate? }
// ---------------------------------------------------------------------------
exports.updateModule = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check (admin/owner required) ────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";
    if (!isAdmin) {
      return res
        .status(403)
        .json({ message: "Only workspace admins can perform this action" });
    }

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Check at least one field provided ─────────────────────
    const {
      name,
      description,
      type,
      category,
      isPrivate,
      permissionOverrides,
    } = req.body;
    const hasAny =
      name !== undefined ||
      description !== undefined ||
      type !== undefined ||
      category !== undefined ||
      isPrivate !== undefined ||
      permissionOverrides !== undefined;

    if (!hasAny) {
      return res.status(400).json({ message: "No update fields provided" });
    }

    // ── 4. Apply fields ──────────────────────────────────────────
    const changes = {};

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: "Module name cannot be empty" });
      }
      if (name.trim().length > 100) {
        return res
          .status(400)
          .json({ message: "Module name must be 100 characters or fewer" });
      }
      module.name = name.trim();
      changes.name = module.name;
    }

    if (description !== undefined) {
      module.description = description?.trim() || null;
      changes.description = module.description;
    }

    if (type !== undefined) {
      const validTypes = ["text", "announcement", "voice"];
      if (!validTypes.includes(type)) {
        return res
          .status(400)
          .json({ message: "Type must be 'text', 'announcement', or 'voice'" });
      }
      module.type = type;
      changes.type = type;
    }

    if (category !== undefined) {
      if (category === null) {
        module.category = null;
        changes.category = null;
      } else {
        const categoryExists = workspace.categories?.some(
          (c) => c.name === category || c === category,
        );
        if (!categoryExists) {
          return res
            .status(400)
            .json({ message: "Category not found in this workspace" });
        }
        module.category = category;
        changes.category = category;
      }
    }

    if (isPrivate !== undefined) {
      module.isPrivate = isPrivate;
      changes.isPrivate = isPrivate;
    }

    if (permissionOverrides !== undefined) {
      module.permissionOverrides = permissionOverrides;
      changes.permissionOverrides = permissionOverrides;
    }

    await module.save();

    // ── 5. Emit socket event ─────────────────────────────────────
    const io = req.app.get("io");
    io.to(`workspace:${workspaceId}`).emit("module:updated", {
      workspaceId,
      moduleId,
      changes,
    });

    return res.json({ message: "Module updated", ...changes });
  } catch (err) {
    console.error("updateModule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/modules/:moduleId
// Delete module and all its messages (admin/owner only).
// ---------------------------------------------------------------------------
exports.deleteModule = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 2c. Permission check (MANAGE_CHANNELS required) ──────────
    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.MANAGE_CHANNELS)) {
      return res.status(403).json({
        message:
          "Only members with Manage Channels permission can delete modules",
      });
    }

    // ── 3. Emit before deletion ──────────────────────────────────
    const io = req.app.get("io");
    io.to(`workspace:${workspaceId}`).emit("module:deleted", {
      workspaceId,
      moduleId,
    });

    // ── 4 & 5. Delete messages then module ───────────────────────
    await ModuleMessage.deleteMany({ moduleId });
    await module.deleteOne();

    return res.json({ message: "Module deleted" });
  } catch (err) {
    console.error("deleteModule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/modules/:moduleId/position
// Reorder module within or across categories.
// Body: { position, category? }
// ---------------------------------------------------------------------------
exports.reorderModule = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check (admin/owner required) ────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";
    if (!isAdmin) {
      return res
        .status(403)
        .json({ message: "Only workspace admins can perform this action" });
    }

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Apply position & optional category ────────────────────
    const { position, category } = req.body;

    if (position === undefined || position === null) {
      return res.status(400).json({ message: "position is required" });
    }

    module.position = position;

    if (category !== undefined) {
      if (category !== null) {
        const categoryExists = workspace.categories?.some(
          (c) => c.name === category || c === category,
        );
        if (!categoryExists) {
          return res
            .status(400)
            .json({ message: "Category not found in this workspace" });
        }
      }
      module.category = category;
    }

    await module.save();

    return res.json({ message: "Module reordered" });
  } catch (err) {
    console.error("reorderModule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId/messages
// Get paginated message history for a module.
// Query: page (default 1)
// ---------------------------------------------------------------------------
exports.getModuleMessages = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Private module check ──────────────────────────────────
    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied to this module" });
    }

    // ── 4. Pagination ────────────────────────────────────────────
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skip = (page - 1) * limit;

    // ── 5 & 6. Query with deletedFor filter ─────────────────────
    const messages = await ModuleMessage.find({ moduleId })
      .where("deletedFor")
      .ne(req.user.id)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "name avatar")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name avatar",
        },
      })
      .populate({
        path: "readBy.user",
        select: "name avatar",
      });

    // ── 7. Return oldest-first ───────────────────────────────────
    const hasMore = messages.length === limit;
    return res.json({ messages: messages.reverse(), hasMore });
  } catch (err) {
    console.error("getModuleMessages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId/thread
// Get thread replies for a message.
// ---------------------------------------------------------------------------
exports.getThreadMessages = async (req, res) => {
  try {
    const { workspaceId, moduleId, msgId } = req.params;

    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) return res.status(404).json({ message: "Module not found" });

    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const messages = await ModuleMessage.find({ moduleId, replyTo: msgId })
      .where("deletedFor")
      .ne(req.user.id)
      .sort({ createdAt: 1 })
      .populate("sender", "name avatar");

    return res.json({ messages });
  } catch (err) {
    console.error("getThreadMessages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId/pinned
// Get pinned messages for a module.
// ---------------------------------------------------------------------------
exports.getPinnedMessages = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) return res.status(404).json({ message: "Module not found" });

    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const messages = await ModuleMessage.find({ moduleId, isPinned: true })
      .where("deletedFor")
      .ne(req.user.id)
      .sort({ pinnedAt: -1 })
      .populate("sender", "name avatar");

    return res.json({ pinnedMessages: messages });
  } catch (err) {
    console.error("getPinnedMessages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId/search
// POST /api/workspaces/:workspaceId/modules/:moduleId/messages
// Send a message in a module.
// Body: { text?, gifUrl?, replyTo? }
// ---------------------------------------------------------------------------
exports.sendModuleMessage = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Membership check ──────────────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Check access & permissions ──────────────────────────────
    const perms = computePermissions(workspace, memberRecord, module);

    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied to this module" });
    }

    if (!perms.has(Workspace.PERMISSIONS.SEND_MESSAGES)) {
      return res
        .status(403)
        .json({ message: "You do not have permission to send messages here" });
    }

    if (
      module.type === "announcement" &&
      !perms.has(Workspace.PERMISSIONS.MANAGE_MESSAGES) &&
      !perms.has(Workspace.PERMISSIONS.MANAGE_CHANNELS)
    ) {
      return res.status(403).json({
        message:
          "Only members with Manage Messages permission can post in announcements",
      });
    }

    // ── 4 & 5. Validate content ──────────────────────────────────
    let { text, gifUrl, replyTo } = req.body;

    if (!text && !gifUrl) {
      return res.status(400).json({ message: "Message content is required" });
    }
    if (text) {
      text = text.trim();
      if (!text) {
        return res.status(400).json({ message: "Message content is required" });
      }
    }

    // ── 6. Parse mentions ────────────────────────────────────────
    let mentions = [];
    if (text) {
      // Get all workspace members to match names against text
      const wsForMentions = await Workspace.findById(workspaceId)
        .select("members roles")
        .populate("members.user", "name");
      const availableMembers = wsForMentions.members
        .filter((m) => m.user && m.user.name)
        .sort((a, b) => b.user.name.length - a.user.name.length);

      const mentionIds = new Set();
      for (const m of availableMembers) {
        // Only include members who can view this module
        const candidatePerms = computePermissions(wsForMentions, m, module);
        if (!candidatePerms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) continue;

        const nameStr = `@${m.user.name}`;
        // Case-insensitive check for the name in the text
        if (text.toLowerCase().includes(nameStr.toLowerCase())) {
          mentionIds.add(String(m.user._id));
        }
      }
      mentions = Array.from(mentionIds);
    }

    // ── 6. Validate replyTo ──────────────────────────────────────
    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) {
        return res.status(400).json({ message: "Invalid reply message" });
      }
      const replyMsg = await ModuleMessage.findOne({ _id: replyTo, moduleId });
      if (!replyMsg) {
        return res.status(400).json({ message: "Invalid reply message" });
      }
    }

    // ── 7. Create message ────────────────────────────────────────
    const message = await ModuleMessage.create({
      moduleId,
      workspaceId,
      sender: req.user.id,
      text: text || null,
      gifUrl: gifUrl || null,
      replyTo: replyTo || null,
      mentions: mentions.length > 0 ? mentions : [],
    });

    // ── 8. Populate ──────────────────────────────────────────────
    const populated = await ModuleMessage.findById(message._id)
      .populate("sender", "name avatar")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name avatar",
        },
      });

    // ── 9. Update lastMessage + unreadCount ──────────────────────
    const freshWorkspace =
      await Workspace.findById(workspaceId).select("members");
    const inc = {};
    for (const m of freshWorkspace.members) {
      if (m.user.toString() !== req.user.id) {
        inc[`unreadCount.${m.user}`] = 1;
      }
    }
    await Module.findByIdAndUpdate(moduleId, {
      lastMessage: {
        text: text || "GIF",
        sender: req.user.id,
        timestamp: message.createdAt,
      },
      $inc: inc,
    });

    // ── 10. Emit socket event ────────────────────────────────────
    const io = req.app.get("io");
    io.to(`module:${moduleId}`).emit("module:message:new", populated);

    // ── 11. Send notifications for mentions ──────────────────────
    if (mentions.length > 0) {
      const { emitToUser } = createHelpers(io);
      for (const mentionedUserId of mentions) {
        if (mentionedUserId !== req.user.id) {
          await NotificationService.push(emitToUser, {
            recipientId: mentionedUserId,
            type: "workspace_mention",
            actorId: req.user.id,
            data: {
              workspaceId,
              moduleId,
              moduleName: module.name,
              workspaceName: workspace.name,
            },
          });
        }
      }
    }

    // ── 11. Respond ──────────────────────────────────────────────
    return res.status(201).json(populated);
  } catch (err) {
    console.error("sendModuleMessage error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/modules/:moduleId/seen
// Mark module messages as seen by the current user.
// Body: { lastSeenMessageId? }
// ---------------------------------------------------------------------------
exports.markModuleSeen = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Reset unread count ────────────────────────────────────
    await Module.findByIdAndUpdate(moduleId, {
      $set: { [`unreadCount.${req.user.id}`]: 0 },
    });

    // ── 4. Mark messages as read up to pivot ────────────────────
    const { lastSeenMessageId } = req.body;

    if (lastSeenMessageId) {
      if (!mongoose.Types.ObjectId.isValid(lastSeenMessageId)) {
        return res.status(400).json({ message: "Invalid message ID" });
      }

      const pivot = await ModuleMessage.findOne({
        _id: lastSeenMessageId,
        moduleId,
      });
      if (!pivot) {
        return res.status(400).json({ message: "Message not found" });
      }

      const readAt = new Date();
      await ModuleMessage.updateMany(
        {
          moduleId,
          "readBy.user": { $ne: req.user.id },
          createdAt: { $lte: pivot.createdAt },
        },
        { $addToSet: { readBy: { user: req.user.id, readAt } } },
      );

      const io = req.app.get("io");
      io.to(`module:${moduleId}`).emit("module:message:status", {
        moduleId,
        status: "read",
        upToMessageId: lastSeenMessageId,
        readBy: {
          userId: req.user.id,
          readAt,
        },
      });
    }

    return res.json({ message: "Marked as seen" });
  } catch (err) {
    console.error("markModuleSeen error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId
// Edit a module message (sender only).
// Body: { text }
// ---------------------------------------------------------------------------
exports.editModuleMessage = async (req, res) => {
  try {
    const { workspaceId, moduleId, msgId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(msgId)) {
      return res.status(400).json({ message: "Invalid message ID" });
    }

    // ── 2. Inline membership check (any member) ──────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;

    // ── 2b. Fetch message ────────────────────────────────────────
    const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // ── 3. Ownership check ───────────────────────────────────────
    if (message.sender.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ message: "You can only edit your own messages" });
    }

    // ── 4. Not deleted check ─────────────────────────────────────
    if (message.isDeleted) {
      return res.status(400).json({ message: "Cannot edit a deleted message" });
    }

    // ── 5. Validate new text ─────────────────────────────────────
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Message text is required" });
    }
    if (text.trim().length > 4000) {
      return res
        .status(400)
        .json({ message: "Message must be 4000 characters or fewer" });
    }

    // ── 6. Update ────────────────────────────────────────────────
    message.text = text.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    // ── 7. Populate sender ───────────────────────────────────────
    await message.populate("sender", "name avatar");

    // ── 8. Emit socket event ─────────────────────────────────────
    const io = req.app.get("io");
    io.to(`module:${moduleId}`).emit("module:message:edited", {
      _id: message._id,
      moduleId,
      text: message.text,
      editedAt: message.editedAt,
      isEdited: true,
    });

    return res.json(message);
  } catch (err) {
    console.error("editModuleMessage error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId
// Soft-delete a module message.
// Query: forEveryone=true (admin/sender only)
// ---------------------------------------------------------------------------
exports.deleteModuleMessage = async (req, res) => {
  try {
    const { workspaceId, moduleId, msgId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(msgId)) {
      return res.status(400).json({ message: "Invalid message ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    // ── 2b. Fetch module for permissions ─────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 2c. Fetch message ────────────────────────────────────────
    const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    const forEveryone = req.query.forEveryone === "true";

    // ── 3. Branch on deletion mode ───────────────────────────────
    if (forEveryone) {
      const perms = computePermissions(workspace, memberRecord, module);
      const isSender = message.sender.toString() === req.user.id;

      // Only sender or someone with MANAGE_MESSAGES can delete for everyone
      if (!isSender && !perms.has(Workspace.PERMISSIONS.MANAGE_MESSAGES)) {
        return res.status(403).json({
          message:
            "Only the sender or members with Manage Messages permission can delete for everyone",
        });
      }

      message.isDeleted = true;
      message.text = "";
      message.gifUrl = null;
      await message.save();

      const io = req.app.get("io");
      io.to(`module:${moduleId}`).emit("module:message:deleted", {
        messageId: msgId,
        moduleId,
        forEveryone: true,
      });
    } else {
      // Delete for me — add to deletedFor silently
      await ModuleMessage.findByIdAndUpdate(msgId, {
        $addToSet: { deletedFor: req.user.id },
      });
    }

    return res.json({ message: "Message deleted" });
  } catch (err) {
    console.error("deleteModuleMessage error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/modules/:moduleId/search
// Search for messages.
// ---------------------------------------------------------------------------
exports.searchModuleMessages = async (req, res) => {
  try {
    const { workspaceId, moduleId } = req.params;
    const { q } = req.query;

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }

    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { workspace, memberRecord } = result;

    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) return res.status(404).json({ message: "Module not found" });

    const perms = computePermissions(workspace, memberRecord, module);
    if (!perms.has(Workspace.PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!q || !q.trim()) {
      return res.json({ messages: [] });
    }

    // Rely on MongoDB text index
    const messages = await ModuleMessage.find({
      moduleId,
      $text: { $search: q },
    })
      .where("deletedFor")
      .ne(req.user.id)
      .sort({ score: { $meta: "textScore" } })
      .limit(30)
      .populate("sender", "name avatar");

    return res.json({ messages });
  } catch (err) {
    console.error("searchModuleMessages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/modules/:moduleId/messages/:msgId/react
// Toggle an emoji reaction on a module message.
// Body: { emoji }
// ---------------------------------------------------------------------------
exports.reactToModuleMessage = async (req, res) => {
  try {
    const { workspaceId, moduleId, msgId } = req.params;

    // ── 1. Validate IDs ──────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: "Invalid module ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(msgId)) {
      return res.status(400).json({ message: "Invalid message ID" });
    }

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;

    // ── 2b. Validate emoji ───────────────────────────────────────
    const { emoji } = req.body;
    if (!emoji || !emoji.trim()) {
      return res.status(400).json({ message: "Emoji is required" });
    }
    if (emoji.length > 10) {
      return res.status(400).json({ message: "Invalid emoji" });
    }

    // ── 3. Fetch message ─────────────────────────────────────────
    const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
    if (!message || message.isDeleted) {
      return res.status(404).json({ message: "Message not found" });
    }

    // ── 4. Toggle reaction ───────────────────────────────────────
    const reactions = message.reactions || new Map();
    const currentUsers = reactions.get(emoji) || [];
    const userId = req.user.id;
    const alreadyReacted = currentUsers.map(String).includes(userId);

    if (alreadyReacted) {
      // Remove reaction
      const updated = currentUsers.filter((id) => id.toString() !== userId);
      if (updated.length === 0) {
        reactions.delete(emoji);
      } else {
        reactions.set(emoji, updated);
      }
    } else {
      // Add reaction
      reactions.set(emoji, [...currentUsers, userId]);
    }

    message.reactions = reactions;
    await message.save();

    // ── 5. Convert Map to plain object ───────────────────────────
    const reactionsObj = {};
    for (const [key, val] of message.reactions.entries()) {
      reactionsObj[key] = val;
    }

    // ── 6. Emit socket event ─────────────────────────────────────
    const io = req.app.get("io");
    io.to(`module:${moduleId}`).emit("module:message:reacted", {
      messageId: msgId,
      moduleId,
      reactions: reactionsObj,
    });

    return res.json({ reactions: reactionsObj });
  } catch (err) {
    console.error("reactToModuleMessage error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};
