/**
 * conversation:seen handler
 *
 * Export: registerConversationHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const registerConversationHandlers = (socket, { emitToUser }) => {
  socket.on(
    "conversation:seen",
    async ({ conversationId, lastSeenMessageId }) => {
      // ✅ FIX: Only require conversationId, make lastSeenMessageId optional
      if (!conversationId) return;

      console.log("👁️ conversation:seen received:", {
        conversationId,
        lastSeenMessageId,
        userId: socket.userId,
      });

      try {
        // Verify the requesting user is a participant
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: socket.userId,
        });

        if (!conversation) return 

        // Reset unread count FIRST (before checking lastSeenMessageId)
        const result = await Conversation.findByIdAndUpdate(
          conversationId,
          { $set: { [`unreadCount.${socket.userId}`]: 0 } },
          { new: true },
        );

        console.log("✅ Unread count reset to 0 for user:", socket.userId);
        console.log("   Updated conversation:", result?._id);

        // ✅ Emit unread count update to frontend
        await emitToUser(socket.userId, "unread:update", {
          conversationId,
          unreadCount: 0,
        });

        console.log("✅ Emitted unread:update to user");

        // ✅ Only mark messages as read if lastSeenMessageId is provided
        if (!lastSeenMessageId) {
          console.log(
            "⚠️ No lastSeenMessageId provided, skipping message status update",
          );
          return;
        }

        // Get the pivot message's createdAt for a range update
        const pivotMessage = await Message.findOne({
          _id: lastSeenMessageId,
          conversationId,
        });

        if (!pivotMessage) {
          console.log("❌ Pivot message not found:", lastSeenMessageId);
          return;
        }

        const seenAt = new Date();

        // Bulk update: all messages sent TO this user, not yet "read", up to pivot
        const messageUpdateResult = await Message.updateMany(
          {
            conversationId,
            receiverId: socket.userId,
            status: { $ne: "read" },
            createdAt: { $lte: pivotMessage.createdAt },
          },
          { $set: { status: "read", seenAt } },
        );

        console.log(
          `📨 Marked ${messageUpdateResult.modifiedCount} messages as read`,
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

        console.log("✅ Message status updates sent to both participants");
      } catch (err) {
        console.error("❌ conversation:seen error:", err.message);
        console.error(err.stack);
      }
    },
  );

  // ----------------------------------------------------------------
  // conversation:join / conversation:leave
  // Client emits when opening / closing a conversation window.
  // Joins the socket into a named room for real-time broadcasting.
  // ----------------------------------------------------------------
  socket.on("conversation:join", (conversationId) => {
    if (conversationId) socket.join(`conv:${conversationId}`);
  });

  socket.on("conversation:leave", (conversationId) => {
    if (conversationId) socket.leave(`conv:${conversationId}`);
  });
};

module.exports = registerConversationHandlers;
