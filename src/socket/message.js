/**
 * message:send handler
 *
 * Export: registerMessageHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const registerMessageHandlers = (socket, { emitToUser, isUserOnline }) => {
  // ----------------------------------------------------------------
  // message:send
  // Client emits: { conversationId, receiverId, text, tempId }
  // ----------------------------------------------------------------
  socket.on(
    "message:send",
    async ({ conversationId, receiverId, text, tempId }) => {
      if (!conversationId || !receiverId || !text?.trim()) return;

      try {
        // 1. Persist to MongoDB
        const message = await Message.create({
          conversationId,
          sender: socket.userId,
          receiverId,
          text: text.trim(),
          status: "sent",
        });

        // 2. Update the conversation's lastMessage snapshot
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: {
            text: text.trim(),
            sender: socket.userId,
            timestamp: message.createdAt,
          },
          updatedAt: message.createdAt,
        });

        // 3. Populate sender info for the response payload
        await message.populate("sender", "name avatar");

        const payload = {
          _id: message._id,
          tempId,
          conversationId,
          sender: message.sender,
          receiverId,
          text: message.text,
          status: message.status,
          createdAt: message.createdAt,
        };

        // 4. Ack back to ALL sender tabs (replaces the optimistic bubble)
        await emitToUser(socket.userId, "message:new", payload);

        // 5. Auto-deliver if receiver is currently online
        const receiverOnline = await isUserOnline(receiverId);

        if (receiverOnline) {
          // 5a. Update status in DB
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

          // 5b. Push the message to all receiver tabs (with delivered status)
          await emitToUser(receiverId, "message:new", {
            ...payload,
            status: "delivered",
            deliveredAt,
          });

          // 5c. Notify BOTH sides so ticks update on sender and receiver UIs
          await emitToUser(socket.userId, "message:status", deliveredPayload);
          await emitToUser(receiverId, "message:status", deliveredPayload);
        } else {
          // Receiver offline — the message will land when they reconnect
          await emitToUser(receiverId, "message:new", payload);
        }
      } catch (err) {
        console.error("message:send error:", err.message);
        socket.emit("message:error", { message: "Failed to send message" });
      }
    },
  );
};

module.exports = registerMessageHandlers;
