/**
 * conversation:seen handler
 *
 * Export: registerConversationHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const registerConversationHandlers = (socket, { emitToUser }) => {
  // ----------------------------------------------------------------
  // conversation:seen
  // Client emits: { conversationId, lastSeenMessageId }
  // Bulk-marks all unread messages up to lastSeenMessageId as "read",
  // then notifies both participants so both UIs update their ticks.
  // ----------------------------------------------------------------
  socket.on(
    "conversation:seen",
    async ({ conversationId, lastSeenMessageId }) => {
      if (!conversationId || !lastSeenMessageId) return;

      try {
        // Verify the requesting user is a participant
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: socket.userId,
        });
        if (!conversation) return;

        // Get the pivot message's createdAt for a range update
        const pivotMessage = await Message.findOne({
          _id: lastSeenMessageId,
          conversationId,
        });
        if (!pivotMessage) return;

        const seenAt = new Date();

        // Bulk update: all messages sent TO this user, not yet "read", up to pivot
        await Message.updateMany(
          {
            conversationId,
            receiverId: socket.userId,
            status: { $ne: "read" },
            createdAt: { $lte: pivotMessage.createdAt },
          },
          { $set: { status: "read", seenAt } },
        );

        // Backfill deliveredAt on any that skipped straight from "sent" to "read"
        await Message.updateMany(
          {
            conversationId,
            receiverId: socket.userId,
            status: "read",
            deliveredAt: null,
            createdAt: { $lte: pivotMessage.createdAt },
          },
          { $set: { deliveredAt: seenAt } },
        );

        const statusPayload = {
          conversationId,
          status: "read",
          upToMessageId: lastSeenMessageId,
          seenAt,
        };

        // Find the other participant (original sender of those messages)
        const senderId = conversation.participants
          .map((p) => p.toString())
          .find((id) => id !== socket.userId);

        // Notify both sides — receiver clears unread badge, sender sees blue ticks
        await emitToUser(socket.userId, "message:status", statusPayload);
        if (senderId) {
          await emitToUser(senderId, "message:status", statusPayload);
        }
      } catch (err) {
        console.error("conversation:seen error:", err.message);
      }
    },
  );
};

module.exports = registerConversationHandlers;
