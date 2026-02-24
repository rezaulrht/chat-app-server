/**
 * Socket.io entry point
 *
 * Responsibilities:
 *   1. Authenticate every incoming socket (JWT middleware)
 *   2. Track the socket in Redis on connect / remove it on disconnect
 *   3. Delegate event handling to focused modules
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");

const createHelpers = require("./helpers");
const registerPresenceHandlers = require("./presence");
const registerMessageHandlers = require("./message");
const registerConversationHandlers = require("./conversation");

const socketHandler = (io) => {
  const helpers = createHelpers(io);

  // --- Socket Authentication Middleware ---
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    console.log(`✅ User connected: ${socket.id} (userId: ${socket.userId})`);

    // Register presence handlers and start the heartbeat interval
    const { refreshPresence, cleanup: cleanupPresence } =
      registerPresenceHandlers(socket, io);

    // Store userId → socketId in a Redis SET (supports multiple tabs/devices)
    if (getIsRedisConnected()) {
      try {
        const socketsKey = `sockets:${socket.userId}`;
        await redisClient.sAdd(socketsKey, socket.id);
        await redisClient.expire(socketsKey, 86400);
        await refreshPresence(true); // initial connection → broadcast online status
      } catch (err) {
        console.error("Redis set socket error:", err);
      }
    }

    // ----------------------------------------------------------------
    // message:send
    // Client emits: { conversationId, receiverId, text, tempId }
    // ----------------------------------------------------------------
    socket.on(
      "message:send",
      async ({ conversationId, receiverId, text, tempId, replyTo }) => {
        if (!conversationId || !receiverId || !text?.trim()) return;

        try {
          // 1. Save message to MongoDB (receiverId stored for receipt queries)
          const message = await Message.create({
            conversationId,
            sender: socket.userId,
            receiverId,
            text: text.trim(),
            replyTo: replyTo || null, // NEW
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

          // --- NEW THREAD POPULATION ---
          if (message.replyTo) {
            await message.populate({
              path: "replyTo",
              select: "text sender",
              populate: { path: "sender", select: "name avatar" },
            });
          }

          // 3. Populate sender info for the response payload
          await message.populate("sender", "name avatar");

          const payload = {
            _id: message._id,
            tempId,
            conversationId,
            sender: message.sender,
            receiverId,
            text: message.text,
            replyTo: message.replyTo || null, // NEW
            status: message.status,
            createdAt: message.createdAt,
          };

          // 4. Ack back to ALL sender tabs (replaces optimistic bubble with real _id)
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
            // Receiver offline — push message:new so it lands when they reconnect
            await emitToUser(receiverId, "message:new", payload);
          }
        } catch (err) {
          console.error("message:send error:", err.message);
          socket.emit("message:error", { message: "Failed to send message" });
        }
      },
    );

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

          // Get the pivot message's createdAt so we can do a range update
          const pivotMessage = await Message.findOne({
            _id: lastSeenMessageId,
            conversationId,
          });
          if (!pivotMessage) return;

          const seenAt = new Date();

          // Bulk update: all messages sent TO this user, not yet "read", up to pivot
          // "seen" implies "delivered" — both status and deliveredAt are set together
          await Message.updateMany(
            {
              conversationId,
              receiverId: socket.userId,
              status: { $ne: "read" },
              createdAt: { $lte: pivotMessage.createdAt },
            },
            {
              $set: {
                status: "read",
                seenAt,
                // Backfill deliveredAt for messages that skipped "delivered"
              },
            },
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

          // Find the other participant (the original sender of those messages)
          const senderId = conversation.participants
            .map((p) => p.toString())
            .find((id) => id !== socket.userId);

          // Notify both sides — receiver's UI clears unread badge, sender's UI shows blue ticks
          await emitToUser(socket.userId, "message:status", statusPayload);
          if (senderId) {
            await emitToUser(senderId, "message:status", statusPayload);
          }
        } catch (err) {
          console.error("conversation:seen error:", err.message);
        }
      },
    );

    // ----------------------------------------------------------------
    // presence:ping - client should send every ~25-30s to refresh TTL
    // ----------------------------------------------------------------
    socket.on("presence:ping", async () => {
      await refreshPresence(false);
    });

    // ----------------------------------------------------------------
    // Handle disconnection — clean up Redis mapping
    // ----------------------------------------------------------------
    socket.on("disconnect", async () => {
      console.log(
        `❌ User disconnected: ${socket.id} (userId: ${socket.userId})`,
      );

      cleanupPresence();

      if (getIsRedisConnected()) {
        try {
          // Remove only this socket from the SET (other tabs remain)
          await redisClient.sRem(`sockets:${socket.userId}`, socket.id);

          // Only mark offline when no sockets remain for this user
          const remainingSockets = await redisClient.sCard(
            `sockets:${socket.userId}`,
          );

          if (remainingSockets === 0) {
            const disconnectTime = Date.now().toString();
            await redisClient.set(`lastSeen:${socket.userId}`, disconnectTime, {
              EX: 604800,
            });
            console.log(
              `Last seen set for user ${socket.userId}: ${disconnectTime}`,
            );

            await redisClient.del(`presence:${socket.userId}`);

            io.emit("presence:update", {
              userId: socket.userId,
              online: false,
            });
            console.log(
              `Presence:update emitted for user ${socket.userId} - OFFLINE`,
            );
          } else {
            console.log(
              `User ${socket.userId} still has ${remainingSockets} active socket(s) — staying online`,
            );
          }
        } catch (err) {
          console.error("Redis disconnect error:", err);
        }
      }
    });
  });
};

module.exports = socketHandler;
