/**
 * Socket.io event handlers and configuration
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const PRESENCE_TTL_SECONDS = 60;
const PRESENCE_REFRESH_MS = 25000;
const PRESENCE_GRACE_MS = 2000;

const socketHandler = (io) => {
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

  // ----------------------------------------------------------------
  // Helper: emit an event to ALL active sockets for a user (multi-tab/device)
  // ----------------------------------------------------------------
  const emitToUser = async (userId, event, data) => {
    if (!getIsRedisConnected()) return;
    try {
      const socketIds = await redisClient.sMembers(`sockets:${userId}`);
      for (const sid of socketIds) {
        io.to(sid).emit(event, data);
      }
    } catch (err) {
      console.error(`emitToUser error (${event}):`, err);
    }
  };

  // Helper: returns true if the user has at least one active socket connection
  const isUserOnline = async (userId) => {
    if (!getIsRedisConnected()) return false;
    try {
      const count = await redisClient.sCard(`sockets:${userId}`);
      return count > 0;
    } catch (err) {
      return false;
    }
  };

  io.on("connection", async (socket) => {
    console.log(`✅ User connected: ${socket.id} (userId: ${socket.userId})`);

    let presenceInterval = null;

    const refreshPresence = async (isInitialConnection = false) => {
      if (!getIsRedisConnected()) return;

      try {
        const presenceKey = `presence:${socket.userId}`;
        const now = Date.now().toString();

        // Check if user was previously offline
        const wasOnline = await redisClient.exists(presenceKey);

        // Set or update presence
        await redisClient.set(presenceKey, now, { EX: PRESENCE_TTL_SECONDS });

        // Emit presence update if this is initial connection or user was offline
        if (isInitialConnection || !wasOnline) {
          io.emit("presence:update", { userId: socket.userId, online: true });
          console.log(
            `Presence:update emitted for user ${socket.userId} - ONLINE`,
          );
        }
      } catch (err) {
        console.error("Redis presence refresh error:", err);
      }
    };

    // Store userId -> socketId in a Redis SET (supports multiple tabs/devices)
    if (getIsRedisConnected()) {
      try {
        const socketsKey = `sockets:${socket.userId}`;
        await redisClient.sAdd(socketsKey, socket.id);
        await redisClient.expire(socketsKey, 86400);
        // Pass true to indicate this is initial connection
        await refreshPresence(true);
        presenceInterval = setInterval(
          () => refreshPresence(false),
          PRESENCE_REFRESH_MS,
        );
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
      async ({ conversationId, receiverId, text, tempId }) => {
        if (!conversationId || !receiverId || !text?.trim()) return;

        try {
          // 1. Save message to MongoDB (receiverId stored for receipt queries)
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

      if (presenceInterval) {
        clearInterval(presenceInterval);
      }

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
