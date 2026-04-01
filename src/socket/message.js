/**
 * message:send handler
 *
 * Export: registerMessageHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const r2Client = require("../config/r2");
const User = require("../models/User");
const NotificationService = require("../services/notification.service");
const createHelpers = require("./helpers");

async function deleteR2Attachments(attachments) {
  if (!attachments?.length) return;
  await Promise.allSettled(
    attachments.map((att) => {
      const key = att.publicId || att.url?.split("/").pop();
      if (!key) return Promise.resolve();
      return r2Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
    }),
  );
}

/**
 * Parse @name mentions from message text.
 * Returns array of matched user IDs from the given participants list.
 * Participants must be populated objects with { _id, name }.
 */
async function parseMentions(text, participants, senderId) {
  if (!text) return [];
  const mentioned = new Set();
  const sorted = [...participants].sort(
    (a, b) => b.name.length - a.name.length,
  );
  for (const p of sorted) {
    if (p._id.toString() === senderId) continue;
    if (text.toLowerCase().includes(`@${p.name.toLowerCase()}`)) {
      mentioned.add(p._id.toString());
    }
  }
  return Array.from(mentioned);
}

function sanitizeMentionIds(mentions, allowedIds = [], senderId) {
  if (!Array.isArray(mentions) || mentions.length === 0) return [];
  const allowed = new Set(allowedIds.map(String));
  const normalized = new Set();

  for (const mention of mentions) {
    const id =
      typeof mention === "object"
        ? mention?._id?.toString() || mention?.id?.toString()
        : mention?.toString?.();

    if (!id) continue;
    if (senderId && id === senderId.toString()) continue;
    if (allowed.size > 0 && !allowed.has(id)) continue;
    normalized.add(id);
  }

  return Array.from(normalized);
}

const registerMessageHandlers = (socket, { emitToUser, isUserOnline, io }) => {
  // ----------------------------------------------------------------
  // message:send
  // DM  — client emits: { conversationId, receiverId, text, tempId, replyTo, gifUrl }
  // Group — client emits: { conversationId, text, tempId, replyTo, gifUrl }
  //          (no receiverId needed for groups)
  // ----------------------------------------------------------------
  socket.on(
    "message:send",
    async ({
      conversationId,
      receiverId,
      text,
      gifUrl,
      tempId,
      replyTo,
      attachments,
      mentions,
    }) => {
      if (!conversationId) return;
      if (
        !text?.trim() &&
        !gifUrl &&
        (!attachments || attachments.length === 0)
      )
        return;

      try {
        // Fetch conversation to determine type and validate membership
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: socket.userId,
        });
        if (!conversation) {
          return socket.emit("message:error", {
            message: "Conversation not found or access denied",
          });
        }

        const isGroup = conversation.type === "group";

        // DMs must supply a receiverId
        if (!isGroup && !receiverId) {
          return socket.emit("message:error", {
            message: "receiverId is required for direct messages",
          });
        }

        // ── Build and save the message ──────────────────────────────
        const messageData = {
          conversationId,
          sender: socket.userId,
          receiverId: isGroup ? null : receiverId,
          status: "sent",
          replyTo: replyTo || null,
          attachments: attachments || [],
        };
        if (text?.trim()) messageData.text = text.trim();
        if (gifUrl) messageData.gifUrl = gifUrl;

        const message = await Message.create(messageData);

        // ── Handle Thread Metadata Update ────────────────────────────
        if (replyTo) {
          const updatedReplyTo = await Message.findByIdAndUpdate(
            replyTo,
            {
              $inc: { replyCount: 1 },
              $set: { lastReplyAt: message.createdAt },
            },
            { new: true },
          );

          // Emit thread update to the room
          io.to(`conv:${conversationId}`).emit("message:thread:update", {
            messageId: replyTo,
            replyCount: updatedReplyTo.replyCount,
            lastReplyAt: message.createdAt,
          });
        }

        // ── Populate replyTo + sender for the payload ───────────────
        if (message.replyTo) {
          await message.populate({
            path: "replyTo",
            select: "text sender",
            populate: { path: "sender", select: "name avatar" },
          });
        }
        await message.populate("sender", "name avatar");

        // ── Update lastMessage + unreadCount ────────────────────────
        const lastMessageUpdate = {
          text: gifUrl ? "GIF" : text?.trim() || "",
          sender: socket.userId,
          timestamp: message.createdAt,
          gifUrl: gifUrl || null,
          attachments: attachments?.length > 0 ? attachments : [],
        };

        if (isGroup) {
          // Increment unreadCount for every participant except the sender
          const inc = {};
          conversation.participants.forEach((p) => {
            if (p.toString() !== socket.userId) inc[`unreadCount.${p}`] = 1;
          });
          await Conversation.findByIdAndUpdate(
            conversationId,
            {
              lastMessage: lastMessageUpdate,
              updatedAt: message.createdAt,
              $inc: inc,
            },
            { returnDocument: "after" },
          );
        } else {
          await Conversation.findByIdAndUpdate(
            conversationId,
            {
              lastMessage: lastMessageUpdate,
              updatedAt: message.createdAt,
              $inc: { [`unreadCount.${receiverId}`]: 1 },
            },
            { returnDocument: "after" },
          );
        }

        // ── Build shared payload ────────────────────────────────────
        const payload = {
          _id: message._id,
          tempId,
          conversationId,
          sender: message.sender,
          receiverId: isGroup ? null : receiverId,
          text: message.text,
          gifUrl: message.gifUrl,
          attachments: message.attachments,
          replyTo: message.replyTo || null,
          status: message.status,
          createdAt: message.createdAt,
        };

        // ================================================================
        // GROUP PATH — broadcast via Socket.io room
        // ================================================================
        if (isGroup) {
          const roomId = `conv:${conversationId}`;

          // Broadcast message:new to all room members (sender included via emitToUser,
          // other online members receive it through the room broadcast)
          io.to(roomId).emit("message:new", payload);

          // Track delivery and send unread:update to each online participant
          const otherParticipants = conversation.participants
            .map((p) => p.toString())
            .filter((id) => id !== socket.userId);

          const deliveredTo = [];
          const deliveredAt = new Date();

          // Fetch once before the loop — avoids N+1 DB reads for large groups
          const updatedConv =
            await Conversation.findById(conversationId).select("unreadCount");

          for (const participantId of otherParticipants) {
            const online = await isUserOnline(participantId);
            if (online) {
              deliveredTo.push({ user: participantId, deliveredAt });
            }

            const unreadCount =
              updatedConv?.unreadCount?.get(participantId) || 0;
            await emitToUser(participantId, "unread:update", {
              conversationId,
              unreadCount,
            });
          }

          // Persist deliveredTo entries if any participants were online
          if (deliveredTo.length > 0) {
            await Message.findByIdAndUpdate(message._id, {
              $push: { deliveredTo: { $each: deliveredTo } },
            });
          }

          // ── Notifications ────────────────────────────────────────
          // Populate participants to resolve @mention names
          const populatedParticipants = await User.find({
            _id: { $in: conversation.participants },
          })
            .select("_id name")
            .lean();

          const participantIds = conversation.participants.map((p) =>
            p.toString(),
          );
          const mentionIdsFromPayload = sanitizeMentionIds(
            mentions,
            participantIds,
            socket.userId,
          );
          const mentionIdsFromText = await parseMentions(
            text,
            populatedParticipants,
            socket.userId,
          );
          const mentionedIds = Array.from(
            new Set([...mentionIdsFromPayload, ...mentionIdsFromText]),
          );
          const mentionedSet = new Set(mentionedIds);

          const { emitToUser: emitFn } = createHelpers(io);

          for (const participantId of otherParticipants) {
            if (mentionedSet.has(participantId)) {
              // Send mention notification instead of generic message notification
              await NotificationService.push(emitFn, {
                recipientId: participantId,
                type: "chat_mention",
                actorId: socket.userId,
                data: {
                  conversationId,
                  conversationName: conversation.name || "Group",
                },
              });
            } else {
              await NotificationService.push(emitFn, {
                recipientId: participantId,
                type: "chat_message",
                actorId: socket.userId,
                data: { conversationId },
              });
            }
          }

          return; // done for group path
        }

        // ================================================================
        // DM PATH — point-to-point via emitToUser (unchanged behaviour)
        // ================================================================
        await emitToUser(socket.userId, "message:new", payload);

        const receiverOnline = await isUserOnline(receiverId);

        if (receiverOnline) {
          const deliveredAt = new Date();
          await Message.findByIdAndUpdate(message._id, {
            status: "delivered",
            deliveredAt,
          });

          const deliveredPayload = {
            messageId: message._id,
            conversationId,
            status: "delivered",
            deliveredAt,
          };

          await emitToUser(receiverId, "message:new", {
            ...payload,
            status: "delivered",
            deliveredAt,
          });

          // Re-read updated unreadCount for receiver
          const updatedConv =
            await Conversation.findById(conversationId).select("unreadCount");
          const unreadCount = updatedConv?.unreadCount?.get(receiverId) || 0;
          await emitToUser(receiverId, "unread:update", {
            conversationId,
            unreadCount,
          });

          await emitToUser(socket.userId, "message:status", deliveredPayload);
          await emitToUser(receiverId, "message:status", deliveredPayload);
        } else {
          await emitToUser(receiverId, "message:new", payload);

          // Re-read updated unreadCount for receiver (they'll get it when they reconnect)
          const updatedConv =
            await Conversation.findById(conversationId).select("unreadCount");
          const unreadCount = updatedConv?.unreadCount?.get(receiverId) || 0;
          await emitToUser(receiverId, "unread:update", {
            conversationId,
            unreadCount,
          });
        }

        // ── Notification ─────────────────────────────────────────
        const { emitToUser: emitFn } = createHelpers(io);
        const mentionIdsFromPayload = sanitizeMentionIds(
          mentions,
          [receiverId],
          socket.userId,
        );

        let receiverWasMentioned = mentionIdsFromPayload.includes(
          receiverId.toString(),
        );

        if (!receiverWasMentioned && text?.includes("@")) {
          const receiver = await User.findById(receiverId)
            .select("_id name")
            .lean();
          if (receiver) {
            const mentionIdsFromText = await parseMentions(
              text,
              [receiver],
              socket.userId,
            );
            receiverWasMentioned = mentionIdsFromText.includes(
              receiverId.toString(),
            );
          }
        }

        await NotificationService.push(emitFn, {
          recipientId: receiverId,
          type: receiverWasMentioned ? "chat_mention" : "chat_message",
          actorId: socket.userId,
          data: { conversationId },
        });
      } catch (err) {
        console.error("message:send error:", err.message);
        socket.emit("message:error", { message: "Failed to send message" });
      }
    },
  );

  socket.on("message:react", async ({ messageId, conversationId, emoji }) => {
    if (!messageId || !conversationId || !emoji) return;

    try {
      const message = await Message.findById(messageId);
      if (!message || message.conversationId.toString() !== conversationId)
        return;

      // Ensure reactions Map exists
      if (!message.reactions) {
        message.reactions = new Map();
      }

      const userIdStr = socket.userId.toString();
      let existingUsers = message.reactions.get(emoji) || [];

      // Ensure existingUsers is an array and doesn't contain the userId as an object vs string mismatch
      existingUsers = existingUsers.map((id) => id.toString());

      const idx = existingUsers.indexOf(userIdStr);

      if (idx > -1) {
        // Toggle off
        existingUsers.splice(idx, 1);
        if (existingUsers.length === 0) {
          message.reactions.delete(emoji);
        } else {
          message.reactions.set(emoji, existingUsers);
        }
      } else {
        // Toggle on
        message.reactions.set(emoji, [...existingUsers, socket.userId]);
      }

      await message.save();

      const reactionsObj = {};
      if (message.reactions) {
        for (const [key, val] of message.reactions.entries()) {
          reactionsObj[key] = val.map((id) => id.toString());
        }
      }

      const payload = { messageId, conversationId, reactions: reactionsObj };

      // Broadcast to everyone in the conversation room
      io.to(`conv:${conversationId}`).emit("message:reacted", payload);
    } catch (err) {
      console.error("message:react error:", err.message);
    }
  });

  // ----------------------------------------------------------------
  // message:edit
  // Client emits: { messageId, newText }
  // ----------------------------------------------------------------
  socket.on("message:edit", async ({ messageId, newText }) => {
    if (!messageId || !newText?.trim()) return;

    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      // Only sender can edit
      if (message.sender.toString() !== socket.userId) return;

      message.text = newText.trim();
      message.isEdited = true;
      message.editedAt = new Date();

      await message.save();

      // Populate full message for frontend
      await message.populate("sender", "name avatar");
      if (message.replyTo) {
        await message.populate({
          path: "replyTo",
          select: "text sender",
          populate: { path: "sender", select: "name avatar" },
        });
      }

      // updated message
      const payload = message.toObject();

      // Broadcast to entire conversation room
      io.to(`conv:${message.conversationId}`).emit("message:edited", payload);
    } catch (err) {
      console.error("message:edit error:", err.message);
      socket.emit("message:error", { message: "Failed to edit message" });
    }
  });

  // ----------------------------------------------------------------
  // message:delete (Delete for Everyone) - FIXED
  // ----------------------------------------------------------------
  socket.on("message:delete", async ({ messageId, conversationId }) => {
    if (!messageId || !conversationId) return;

    try {
      const message = await Message.findById(messageId);
      if (!message || message.conversationId.toString() !== conversationId)
        return;

      // Only sender can delete for everyone
      if (message.sender.toString() !== socket.userId) return;

      await deleteR2Attachments(message.attachments);
      message.isDeleted = true;
      message.text = "This message was deleted"; // optional fallback text
      message.attachments = [];
      await message.save();

      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
      };

      // Broadcast to entire conversation
      io.to(`conv:${conversationId}`).emit("message:deleted", payload);
    } catch (err) {
      console.error("message:delete error:", err.message);
      socket.emit("message:error", { message: "Failed to delete message" });
    }
  });

  // ----------------------------------------------------------------
  // message:deleteForMe - FIXED
  // ----------------------------------------------------------------
  socket.on("message:deleteForMe", async ({ messageId, conversationId }) => {
    if (!messageId || !conversationId) return;

    try {
      const message = await Message.findById(messageId);
      if (!message || message.conversationId.toString() !== conversationId)
        return;

      // Add user to deletedFor array if not already
      if (!message.deletedFor.includes(socket.userId)) {
        message.deletedFor.push(socket.userId);
        await message.save();
      }

      // Only send to this user
      socket.emit("message:deletedForMe", { messageId });
    } catch (err) {
      console.error("message:deleteForMe error:", err.message);
    }
  });
};

module.exports = registerMessageHandlers;
