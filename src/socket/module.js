/**
 * Module socket handlers
 *
 * Export: registerModuleHandlers(socket, { emitToUser, io })
 *
 * Handles inbound events:
 *   module:message:send
 *   module:message:react
 *   module:message:edit
 *   module:message:delete
 *   module:seen
 *   module:typing:start
 *   module:typing:stop
 *   module:join    — manual room subscription
 *   module:leave   — manual room unsubscription
 */

const Workspace = require("../models/Workspace");
const Module = require("../models/Module");
const ModuleMessage = require("../models/ModuleMessage");
const mongoose = require("mongoose");

// Reuse same constants as typing.js
const TYPING_AUTO_STOP_MS = 5000;
const TYPING_THROTTLE_MS = 500;

// Module-level maps — persist across connections in this process
// Key: "moduleId:userId"
const moduleTypingTimers = new Map();

const registerModuleHandlers = (socket, { emitToUser, io }) => {
  // Per-socket throttle: moduleId → last accepted typing:start timestamp
  const lastModuleTypingEmit = new Map();

  // ================================================================
  // module:join / module:leave
  // ================================================================

  socket.on("module:join", async ({ moduleId, workspaceId } = {}) => {
    if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) return;
    try {
      // Verify module exists and user is a workspace member
      const mod = await Module.findById(moduleId).select(
        "workspaceId isPrivate allowedMembers",
      );
      if (!mod) return;

      const workspace = await Workspace.findOne({
        _id: mod.workspaceId,
        "members.user": socket.userId,
      }).select("_id members");
      if (!workspace) return;

      // Private module check
      if (mod.isPrivate) {
        const memberRecord = workspace.members.find(
          (m) => m.user.toString() === socket.userId,
        );
        const isAdmin =
          memberRecord?.role === "owner" || memberRecord?.role === "admin";
        const isAllowed = mod.allowedMembers
          .map(String)
          .includes(socket.userId);
        if (!isAdmin && !isAllowed) return;
      }

      socket.join(`module:${moduleId}`);
    } catch (err) {
      console.error("module:join error:", err.message);
    }
  });

  socket.on("module:leave", ({ moduleId } = {}) => {
    if (moduleId) socket.leave(`module:${moduleId}`);
  });

  // ================================================================
  // module:message:send
  // ================================================================

  socket.on(
    "module:message:send",
    async ({ moduleId, workspaceId, text, gifUrl, tempId, replyTo }) => {
      if (!moduleId || (!text?.trim() && !gifUrl)) return;

      try {
        // Verify module + membership
        const mod = await Module.findOne({ _id: moduleId, workspaceId }).select(
          "workspaceId type isPrivate allowedMembers",
        );
        if (!mod)
          return socket.emit("message:error", { message: "Module not found" });

        const workspace = await Workspace.findOne({
          _id: workspaceId,
          "members.user": socket.userId,
        }).select("members");
        if (!workspace)
          return socket.emit("message:error", { message: "Access denied" });

        const memberRecord = workspace.members.find(
          (m) => m.user.toString() === socket.userId,
        );
        if (!memberRecord) return;

        // Private module — only admins/owners or explicitly allowed members can post
        if (mod.isPrivate) {
          const isAdmin =
            memberRecord.role === "owner" || memberRecord.role === "admin";
          const isAllowed = mod.allowedMembers
            .map(String)
            .includes(socket.userId);
          if (!isAdmin && !isAllowed) {
            return socket.emit("message:error", { message: "Access denied" });
          }
        }

        // Announcement module — only admin/owner can post
        if (mod.type === "announcement") {
          const isAdmin =
            memberRecord.role === "owner" || memberRecord.role === "admin";
          if (!isAdmin) {
            return socket.emit("message:error", {
              message: "Only admins can post in announcement modules",
            });
          }
        }

        // Validate replyTo
        if (replyTo) {
          const replyMsg = await ModuleMessage.findOne({
            _id: replyTo,
            moduleId,
          });
          if (!replyMsg) return;
        }

        // Create the message
        const message = await ModuleMessage.create({
          moduleId,
          workspaceId,
          sender: socket.userId,
          text: text?.trim() || null,
          gifUrl: gifUrl || null,
          replyTo: replyTo || null,
        });

        // Populate sender + replyTo
        await message.populate("sender", "name avatar");
        if (message.replyTo) {
          await message.populate({
            path: "replyTo",
            select: "text sender gifUrl",
            populate: { path: "sender", select: "name avatar" },
          });
        }

        // Update module lastMessage + unread counts for all members except sender
        const inc = {};
        for (const m of workspace.members) {
          if (m.user.toString() !== socket.userId) {
            inc[`unreadCount.${m.user}`] = 1;
          }
        }
        await Module.findByIdAndUpdate(moduleId, {
          lastMessage: {
            text: gifUrl ? "GIF" : text.trim(),
            sender: socket.userId,
            timestamp: message.createdAt,
          },
          $inc: inc,
        });

        const payload = {
          _id: message._id,
          tempId,
          moduleId,
          workspaceId,
          sender: message.sender,
          text: message.text,
          gifUrl: message.gifUrl,
          replyTo: message.replyTo || null,
          reactions: {},
          isEdited: false,
          isDeleted: false,
          createdAt: message.createdAt,
        };

        // Broadcast to everyone in the module room (sender included)
        io.to(`module:${moduleId}`).emit("module:message:new", payload);

        // Send unread:update to each other member
        // Re-fetch module to get fresh unread counts
        const updatedModule =
          await Module.findById(moduleId).select("unreadCount");
        for (const m of workspace.members) {
          if (m.user.toString() !== socket.userId) {
            const unreadCount =
              updatedModule?.unreadCount?.get(m.user.toString()) || 0;
            await emitToUser(m.user.toString(), "module:unread:update", {
              moduleId,
              workspaceId,
              unreadCount,
            });
          }
        }
      } catch (err) {
        console.error("module:message:send error:", err.message);
        socket.emit("message:error", { message: "Failed to send message" });
      }
    },
  );

  // ================================================================
  // module:message:react
  // ================================================================

  socket.on("module:message:react", async ({ msgId, moduleId, emoji }) => {
    if (!msgId || !moduleId || !emoji) return;

    try {
      const message = await ModuleMessage.findOne({
        _id: msgId,
        moduleId,
      }).select("workspaceId reactions isDeleted");
      if (!message || message.isDeleted) return;

      const workspace = await Workspace.findOne({
        _id: message.workspaceId,
        "members.user": socket.userId,
      }).select("_id");
      if (!workspace) return;

      const currentUsers = (message.reactions?.get(emoji) || []).map(String);
      const idx = currentUsers.indexOf(socket.userId);
      let newUsers;

      if (idx > -1) {
        newUsers = currentUsers.filter((_, i) => i !== idx);
      } else {
        newUsers = [...currentUsers, socket.userId];
      }

      const updateOp =
        newUsers.length === 0
          ? { $unset: { [`reactions.${emoji}`]: "" } }
          : { $set: { [`reactions.${emoji}`]: newUsers } };

      const updated = await ModuleMessage.findOneAndUpdate(
        { _id: msgId, moduleId, isDeleted: false },
        updateOp,
        { new: true, select: "reactions" },
      );
      if (!updated) return;

      // Convert Map to plain object for transport
      const reactionsObj = {};
      for (const [key, val] of (updated.reactions || new Map()).entries()) {
        reactionsObj[key] = val.map((id) => id.toString());
      }

      io.to(`module:${moduleId}`).emit("module:message:reacted", {
        msgId,
        moduleId,
        reactions: reactionsObj,
      });
    } catch (err) {
      console.error("module:message:react error:", err.message);
    }
  });

  // ================================================================
  // module:message:edit
  // ================================================================

  socket.on("module:message:edit", async ({ msgId, moduleId, newText }) => {
    if (!msgId || !moduleId || !newText?.trim()) return;

    try {
      const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
      if (!message) return;

      const workspace = await Workspace.findOne({
        _id: message.workspaceId,
        "members.user": socket.userId,
      }).select("_id");
      if (!workspace) return;

      if (message.sender.toString() !== socket.userId) return; // sender only
      if (message.isDeleted) return;

      message.text = newText.trim();
      message.isEdited = true;
      message.editedAt = new Date();
      await message.save();

      await message.populate("sender", "name avatar");

      io.to(`module:${moduleId}`).emit("module:message:edited", {
        _id: message._id,
        moduleId,
        text: message.text,
        editedAt: message.editedAt,
        isEdited: true,
        sender: message.sender,
      });
    } catch (err) {
      console.error("module:message:edit error:", err.message);
      socket.emit("message:error", { message: "Failed to edit message" });
    }
  });

  // ================================================================
  // module:message:delete (delete for everyone)
  // ================================================================

  socket.on("module:message:delete", async ({ msgId, moduleId }) => {
    if (!msgId || !moduleId) return;
    try {
      const message = await ModuleMessage.findOne({ _id: msgId, moduleId });
      if (!message) return;

      // Only sender OR workspace admin/owner can delete for everyone
      if (message.sender.toString() !== socket.userId) {
        // Check if admin/owner
        const workspace = await Workspace.findOne({
          _id: message.workspaceId,
          "members.user": socket.userId,
        }).select("members");
        const memberRecord = workspace?.members.find(
          (m) => m.user.toString() === socket.userId,
        );
        const isAdmin =
          memberRecord?.role === "owner" || memberRecord?.role === "admin";
        if (!isAdmin) return;
      }

      message.isDeleted = true;
      message.text = null;
      message.gifUrl = null;
      await message.save();

      io.to(`module:${moduleId}`).emit("module:message:deleted", {
        msgId: message._id,
        moduleId,
        deletedForEveryone: true,
      });
    } catch (err) {
      console.error("module:message:delete error:", err.message);
    }
  });

  // ================================================================
  // module:message:deleteForMe
  // ================================================================

  socket.on("module:message:deleteForMe", async ({ msgId, moduleId }) => {
    if (!msgId || !moduleId) return;
    try {
      const message = await ModuleMessage.findOne({
        _id: msgId,
        moduleId,
      }).select("workspaceId");
      if (!message) return;

      const workspace = await Workspace.findOne({
        _id: message.workspaceId,
        "members.user": socket.userId,
      }).select("_id");
      if (!workspace) return;

      const updated = await ModuleMessage.findOneAndUpdate(
        { _id: msgId, moduleId },
        { $addToSet: { deletedFor: socket.userId } },
        { new: true, select: "_id" },
      );
      if (!updated) return;

      // Only notify this socket — it's a private action
      socket.emit("module:message:deletedForMe", { msgId, moduleId });
    } catch (err) {
      console.error("module:message:deleteForMe error:", err.message);
    }
  });

  // ================================================================
  // module:typing:start / module:typing:stop
  // ================================================================

  socket.on("module:typing:start", async ({ moduleId } = {}) => {
    if (!moduleId) return;

    // Throttle typing bursts per module on this socket
    const now = Date.now();
    const lastEmit = lastModuleTypingEmit.get(moduleId) ?? 0;
    if (now - lastEmit < TYPING_THROTTLE_MS) return;
    lastModuleTypingEmit.set(moduleId, now);

    // Security: verify user can access this module
    try {
      const mod = await Module.findById(moduleId).select(
        "workspaceId isPrivate allowedMembers",
      );
      if (!mod) return;

      const workspace = await Workspace.findOne({
        _id: mod.workspaceId,
        "members.user": socket.userId,
      }).select("members");
      if (!workspace) return;

      if (mod.isPrivate) {
        const memberRecord = workspace.members.find(
          (m) => m.user.toString() === socket.userId,
        );
        const isAdmin =
          memberRecord?.role === "owner" || memberRecord?.role === "admin";
        const isAllowed = mod.allowedMembers
          .map(String)
          .includes(socket.userId);
        if (!isAdmin && !isAllowed) return;
      }
    } catch {
      return;
    }

    const key = `${moduleId}:${socket.userId}`;
    const typingPayload = {
      moduleId,
      userId: socket.userId,
      isTyping: true,
    };

    // Excludes sender by design
    socket.to(`module:${moduleId}`).emit("module:typing:update", typingPayload);

    // Reset auto-stop timer
    if (moduleTypingTimers.has(key)) {
      clearTimeout(moduleTypingTimers.get(key));
    }

    const timer = setTimeout(() => {
      moduleTypingTimers.delete(key);
      socket.to(`module:${moduleId}`).emit("module:typing:update", {
        moduleId,
        userId: socket.userId,
        isTyping: false,
      });
    }, TYPING_AUTO_STOP_MS);

    moduleTypingTimers.set(key, timer);
  });

  socket.on("module:typing:stop", ({ moduleId } = {}) => {
    if (!moduleId) return;

    const key = `${moduleId}:${socket.userId}`;
    if (moduleTypingTimers.has(key)) {
      clearTimeout(moduleTypingTimers.get(key));
      moduleTypingTimers.delete(key);
    }

    socket.to(`module:${moduleId}`).emit("module:typing:update", {
      moduleId,
      userId: socket.userId,
      isTyping: false,
    });
  });

  // ================================================================
  // module:seen
  // ================================================================

  socket.on("module:seen", async ({ moduleId, lastSeenMessageId }) => {
    if (!moduleId) return;

    try {
      // Verify user can access this module
      const mod = await Module.findById(moduleId).select(
        "workspaceId isPrivate allowedMembers",
      );
      if (!mod) return;

      const workspace = await Workspace.findOne({
        _id: mod.workspaceId,
        "members.user": socket.userId,
      }).select("members");
      if (!workspace) return;

      if (mod.isPrivate) {
        const memberRecord = workspace.members.find(
          (m) => m.user.toString() === socket.userId,
        );
        const isAdmin =
          memberRecord?.role === "owner" || memberRecord?.role === "admin";
        const isAllowed = mod.allowedMembers
          .map(String)
          .includes(socket.userId);
        if (!isAdmin && !isAllowed) return;
      }

      // Reset unread count for this user
      await Module.findByIdAndUpdate(moduleId, {
        $set: { [`unreadCount.${socket.userId}`]: 0 },
      });

      // Send unread clear event to this user (all active sockets)
      await emitToUser(socket.userId, "module:unread:update", {
        moduleId,
        workspaceId: mod.workspaceId,
        unreadCount: 0,
      });

      if (!lastSeenMessageId) return;

      // Find pivot message timestamp for range update
      const pivot = await ModuleMessage.findOne({
        _id: lastSeenMessageId,
        moduleId,
      }).select("createdAt");
      if (!pivot) return;

      const seenAt = new Date();

      // Mark all messages up to pivot as read by this user
      await ModuleMessage.updateMany(
        {
          moduleId,
          "readBy.user": { $ne: socket.userId },
          createdAt: { $lte: pivot.createdAt },
        },
        { $addToSet: { readBy: { user: socket.userId, readAt: seenAt } } },
      );

      io.to(`module:${moduleId}`).emit("module:message:status", {
        moduleId,
        status: "read",
        upToMessageId: lastSeenMessageId,
        readBy: { userId: socket.userId, readAt: seenAt },
      });
    } catch (err) {
      console.error("module:seen error:", err.message);
    }
  });

  // Cleanup function for disconnect
  const cleanup = () => {
    // Clear all module typing timers this socket set
    for (const [key, timer] of moduleTypingTimers.entries()) {
      if (key.endsWith(`:${socket.userId}`)) {
        clearTimeout(timer);
        moduleTypingTimers.delete(key);
      }
    }
  };

  return { cleanup };
};

module.exports = registerModuleHandlers;

// Kept for future controller-driven socket emits outside this handler module.
const emitModuleCreated = (io, workspaceId, data) => {
  io.to(`workspace:${workspaceId}`).emit("module:created", data);
};

const emitModuleUpdated = (io, workspaceId, data) => {
  io.to(`workspace:${workspaceId}`).emit("module:updated", data);
};

const emitModuleDeleted = (io, workspaceId, data) => {
  io.to(`workspace:${workspaceId}`).emit("module:deleted", data);
};

module.exports.emitModuleCreated = emitModuleCreated;
module.exports.emitModuleUpdated = emitModuleUpdated;
module.exports.emitModuleDeleted = emitModuleDeleted;
