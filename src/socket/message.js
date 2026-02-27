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
  // Client emits: { conversationId, receiverId, text, tempId, replyTo }
  // ----------------------------------------------------------------
  socket.on(
    "message:send",
    async ({ conversationId, receiverId, text, gifUrl, tempId, replyTo }) => {
      if (!conversationId || !receiverId) return;
      if (!text?.trim() && !gifUrl) return;

      try {
        const messageData = {
          conversationId,
          sender: socket.userId,
          receiverId,
          status: "sent",
          replyTo: replyTo || null,
        };
        if (text?.trim()) messageData.text = text.trim();
        if (gifUrl) messageData.gifUrl = gifUrl;

        const message = await Message.create(messageData);

        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: {
            text: gifUrl ? "GIF" : text.trim(),
            sender: socket.userId,
            timestamp: message.createdAt,
          },
          updatedAt: message.createdAt,
        });

        if (message.replyTo) {
          await message.populate({
            path: "replyTo",
            select: "text sender",
            populate: { path: "sender", select: "name avatar" },
          });
        }
        await message.populate("sender", "name avatar");

        const payload = {
          _id: message._id,
          tempId,
          conversationId,
          sender: message.sender,
          receiverId,
          text: message.text,
          gifUrl: message.gifUrl,
          replyTo: message.replyTo || null,
          status: message.status,
          createdAt: message.createdAt,
        };

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

          await emitToUser(socket.userId, "message:status", deliveredPayload);
          await emitToUser(receiverId, "message:status", deliveredPayload);
        } else {
          await emitToUser(receiverId, "message:new", payload);
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

      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
        newText: message.text,
        isEdited: true,
        editedAt: message.editedAt,
      };

      await emitToUser(socket.userId, "message:edited", payload);
      await emitToUser(
        message.receiverId.toString(),
        "message:edited",
        payload,
      );
    } catch (err) {
      console.error("message:edit error:", err.message);
    }
  });

  // ----------------------------------------------------------------
  // message:deleteEveryone
  // Client emits: { messageId }
  // ----------------------------------------------------------------
  socket.on("message:deleteEveryone", async ({ messageId }) => {
    if (!messageId) return;

    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.sender.toString() !== socket.userId) return;

      message.isDeleted = true;
      await message.save();

      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
      };

      await emitToUser(socket.userId, "message:deleted", payload);
      await emitToUser(
        message.receiverId.toString(),
        "message:deleted",
        payload,
      );
    } catch (err) {
      console.error("message:deleteEveryone error:", err.message);
    }
  });
};

module.exports = registerMessageHandlers;
