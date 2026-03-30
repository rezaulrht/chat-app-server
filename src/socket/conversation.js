/**
 * conversation:seen handler
 *
 * Export: registerConversationHandlers(socket, helpers)
 */

const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const registerConversationHandlers = (socket, { emitToUser, io }) => {
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

        if (!conversation) return;

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

        const statusPayload = {
          conversationId,
          status: "read",
          upToMessageId: lastSeenMessageId,
          seenAt,
        };

        // ================================================================
        // GROUP PATH — track per-user readBy, broadcast to room
        // ================================================================
        if (conversation.type === "group") {
          // Add this user to readBy on all unread messages up to the pivot
          await Message.updateMany(
            {
              conversationId,
              "readBy.user": { $ne: socket.userId },
              createdAt: { $lte: pivotMessage.createdAt },
            },
            { $addToSet: { readBy: { user: socket.userId, readAt: seenAt } } },
          );

          // Broadcast to all room members so every client can update read indicators
          if (io) {
            io.to(`conv:${conversationId}`).emit("message:status", {
              ...statusPayload,
              readBy: { userId: socket.userId, readAt: seenAt },
            });
          }

          console.log("✅ Group message:status broadcast to room");
          return;
        }

        // ================================================================
        // DM PATH — bulk update receiverId, notify both participants
        // ================================================================

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
  // conversation:customise
  // Client emits when changing chat colour, emoji, or nicknames
  // ----------------------------------------------------------------
  socket.on(
    "conversation:customise",
    async ({ conversationId, type, value, targetUserId }) => {
      try {
        if (!conversationId || !type) return;

        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: socket.userId,
        });

        if (!conversation) return;

        let iterUser = await require("../models/User").findById(socket.userId).select("name");
        let textString = "";

        // Ensure customisation object exists
        if (!conversation.customisation) {
          conversation.customisation = { color: "#00d3bb", emoji: "👍", nicknames: new Map() };
        }

        if (type === "color") {
          conversation.customisation.color = value;
          textString = `${iterUser.name} changed the chat colour.`;
        } else if (type === "emoji") {
          conversation.customisation.emoji = value;
          textString = `${iterUser.name} set the quick reaction to ${value}.`;
        } else if (type === "nickname") {
          if (!targetUserId) return;
          if (value) {
            conversation.customisation.nicknames.set(targetUserId, value);
          } else {
            conversation.customisation.nicknames.delete(targetUserId);
          }
          const targetUser = await require("../models/User").findById(targetUserId).select("name");
          textString = value 
            ? `${iterUser.name} set the nickname for ${targetUser.name} to ${value}.`
            : `${iterUser.name} removed the nickname for ${targetUser.name}.`;
        } else {
          return;
        }
        conversation.markModified("customisation");
        await conversation.save();

        const message = await Message.create({
          conversationId,
          sender: socket.userId,
          isSystem: true,
          systemAction: `update_${type}`,
          text: textString,
        });

        const populatedMessage = await Message.findById(message._id).populate("sender", "name avatar");

        const lastMessageUpdate = {
          text: textString,
          sender: socket.userId,
          timestamp: message.createdAt,
        };

        const isGroup = conversation.type === "group";
        const inc = {};
        conversation.participants.forEach((p) => {
          if (p.toString() !== socket.userId) inc[`unreadCount.${p}`] = 1;
        });

        await Conversation.findByIdAndUpdate(
          conversationId,
          {
            $set: {
              lastMessage: lastMessageUpdate,
              updatedAt: message.createdAt,
            },
            $inc: inc,
          }
        );

        // Broadcast to everyone in the room
        if (io) {
          const roomId = `conv:${conversationId}`;
          // Payload for message:new
          const payload = {
            _id: message._id,
            conversationId,
            sender: populatedMessage.sender,
            text: message.text,
            isSystem: message.isSystem,
            systemAction: message.systemAction,
            createdAt: message.createdAt,
          };
          io.to(roomId).emit("message:new", payload);
          io.to(roomId).emit("conversation:customise:updated", {
            conversationId,
            customisation: conversation.toJSON().customisation,
          });
        }
      } catch (err) {
        console.error("conversation:customise error:", err.message);
      }
    }
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
