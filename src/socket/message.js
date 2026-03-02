/**
 * message:send handler
 *
 * Export: registerMessageHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const registerMessageHandlers = (socket, { emitToUser, isUserOnline, io }) => {
  // ----------------------------------------------------------------
  // message:send
  // DM  — client emits: { conversationId, receiverId, text, tempId, replyTo, gifUrl }
  // Group — client emits: { conversationId, text, tempId, replyTo, gifUrl }
  //          (no receiverId needed for groups)
  // ----------------------------------------------------------------
  socket.on(
    "message:send",
    async ({ conversationId, receiverId, text, gifUrl, tempId, replyTo }) => {
      if (!conversationId) return;
      if (!text?.trim() && !gifUrl) return;

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
        };
        if (text?.trim()) messageData.text = text.trim();
        if (gifUrl) messageData.gifUrl = gifUrl;

        const message = await Message.create(messageData);

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
          text: gifUrl ? "GIF" : text.trim(),
          sender: socket.userId,
          timestamp: message.createdAt,
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
            { new: true },
          );
        } else {
          await Conversation.findByIdAndUpdate(
            conversationId,
            {
              lastMessage: lastMessageUpdate,
              updatedAt: message.createdAt,
              $inc: { [`unreadCount.${receiverId}`]: 1 },
            },
            { new: true },
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

      const existingUsers = message.reactions?.get(emoji) || [];
      const userIdStr = socket.userId.toString();
      const idx = existingUsers.findIndex((id) => id.toString() === userIdStr);

      if (idx > -1) {
        existingUsers.splice(idx, 1);
        if (existingUsers.length === 0) {
          message.reactions.delete(emoji);
        } else {
          message.reactions.set(emoji, existingUsers);
        }
      } else {
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

      // Broadcast to everyone in the conversation room (including the reactor)
      io.to(`conv:${conversationId}`).emit("message:reacted", payload);
    } catch (err) {
      console.error("message:react error:", err.message);
    }
  });
};

module.exports = registerMessageHandlers;
