/**
 * Socket.io entry point
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const Conversation = require("../models/Conversation");

const createHelpers = require("./helpers");
const registerPresenceHandlers = require("./presence");
const registerMessageHandlers = require("./message");
const registerConversationHandlers = require("./conversation");
const registerTypingHandlers = require("./typing");

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

    // Auto-join all group conversation rooms for this user so they receive
    // group broadcasts without needing to manually open each conversation.
    try {
      const groupConvs = await Conversation.find({
        participants: socket.userId,
        type: "group",
      }).select("_id");

      for (const conv of groupConvs) {
        socket.join(`conv:${conv._id}`);
      }
      if (groupConvs.length > 0) {
        console.log(
          `🏠 User ${socket.userId} auto-joined ${groupConvs.length} group room(s)`,
        );
      }
    } catch (err) {
      console.error("Group room auto-join error:", err.message);
    }

    // Delegate event handling to focused modules
    registerMessageHandlers(socket, { ...helpers, io });
    registerConversationHandlers(socket, { ...helpers, io });
    const { cleanup: cleanupTyping } = registerTypingHandlers(socket, {
      ...helpers,
      io,
    });

    // ----------------------------------------------------------------
    // Handle disconnection — clean up Redis mapping
    // ----------------------------------------------------------------
    socket.on("disconnect", async () => {
      console.log(
        `❌ User disconnected: ${socket.id} (userId: ${socket.userId})`,
      );

      cleanupPresence();
      await cleanupTyping();

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
