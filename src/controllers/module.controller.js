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
    const { name, description, type, category, position, isPrivate } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Module name is required" });
    }
    if (name.trim().length > 100) {
      return res
        .status(400)
        .json({ message: "Module name must be 100 characters or fewer" });
    }

    // ── 4. Validate type ─────────────────────────────────────────
    const validTypes = ["text", "announcement"];
    const moduleType = type || "text";
    if (!validTypes.includes(moduleType)) {
      return res
        .status(400)
        .json({ message: "Type must be 'text' or 'announcement'" });
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
    const { memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";

    // ── 3. Fetch and sort modules ────────────────────────────────
    const modules = await Module.find({ workspaceId }).sort({
      category: 1,
      position: 1,
    });

    // ── 4 & 5. Filter private + inject myUnread ──────────────────
    const accessible = modules
      .filter((m) => {
        if (!m.isPrivate) return true;
        if (isAdmin) return true;
        return m.allowedMembers.some((uid) => uid.toString() === req.user.id);
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
    const { memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";

    // ── 3. Fetch module ──────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 4. Private module check ──────────────────────────────────
    if (module.isPrivate && !isAdmin) {
      const allowed = module.allowedMembers.some(
        (uid) => uid.toString() === req.user.id,
      );
      if (!allowed) {
        return res
          .status(403)
          .json({ message: "Access denied to this module" });
      }
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
    const { name, description, type, category, isPrivate } = req.body;
    const hasAny =
      name !== undefined ||
      description !== undefined ||
      type !== undefined ||
      category !== undefined ||
      isPrivate !== undefined;

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
      const validTypes = ["text", "announcement"];
      if (!validTypes.includes(type)) {
        return res
          .status(400)
          .json({ message: "Type must be 'text' or 'announcement'" });
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

    // ── 2. Inline membership check (admin/owner required) ────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { memberRecord } = result;

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
    const { memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Private module check ──────────────────────────────────
    if (module.isPrivate && !isAdmin) {
      const allowed = module.allowedMembers.some(
        (uid) => uid.toString() === req.user.id,
      );
      if (!allowed) {
        return res
          .status(403)
          .json({ message: "Access denied to this module" });
      }
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

    // ── 2. Inline membership check ───────────────────────────────
    const result = await checkMembership(res, workspaceId, req.user.id);
    if (!result) return;
    const { memberRecord } = result;

    // ── 2b. Fetch module ─────────────────────────────────────────
    const module = await Module.findOne({ _id: moduleId, workspaceId });
    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    // ── 3. Announcement check ────────────────────────────────────
    if (module.type === "announcement" && memberRecord.role === "member") {
      return res
        .status(403)
        .json({ message: "Only admins can post in announcement modules" });
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
    const { memberRecord } = result;

    const isAdmin =
      memberRecord.role === "owner" || memberRecord.role === "admin";

    // ── 2b. Fetch message ────────────────────────────────────────
    const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    const forEveryone = req.query.forEveryone === "true";

    // ── 3. Branch on deletion mode ───────────────────────────────
    if (forEveryone) {
      // Only sender or admin can delete for everyone
      const isSender = message.sender.toString() === req.user.id;
      if (!isSender && !isAdmin) {
        return res.status(403).json({
          message: "Only the sender or an admin can delete for everyone",
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
