/**
 * Socket.io entry point
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const Conversation = require("../models/Conversation");
const Workspace = require("../models/Workspace");
const User = require("../models/User");

const createHelpers = require("./helpers");
const registerPresenceHandlers = require("./presence");
const registerMessageHandlers = require("./message");
const registerConversationHandlers = require("./conversation");
const registerTypingHandlers = require("./typing");
const registerWorkspaceHandlers = require("./workspace");
const registerModuleHandlers = require("./module");
const registerFeedHandlers = require("./feed");
const registerCallHandlers = require("./calls");
const registerVoiceChannelHandlers = require("./voiceChannel");
const registerWordSpyHandlers = require("./wordspy");

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
      // Validate that JWT contains id claim and it's a valid identifier
      if (!decoded.id || typeof decoded.id !== "string" || decoded.id.trim() === "") {
        return next(new Error("Authentication error: Invalid token claims"));
      }
      socket.userId = decoded.id;
      socket.data.userId = decoded.id; // required for fetchSockets()-based targeting
      next();
    } catch (err) {
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    // Validate socket.userId before using it
    if (!socket.userId || typeof socket.userId !== "string") {
      socket.disconnect(true);
      return;
    }

    // Cache basic profile on the socket for lightweight event payloads
    try {
      const currentUser = await User.findById(socket.userId)
        .select("name username avatar")
        .lean();
      socket.userName = currentUser?.name || currentUser?.username || "Someone";
      socket.userAvatar = currentUser?.avatar || null;
    } catch (err) {
      socket.userName = "Someone";
      socket.userAvatar = null;
      console.error("Socket user profile lookup error:", err.message);
    }

    console.log(`✅ User connected: ${socket.id} (userId: ${socket.userId})`);
    socket.join(`feed:user:${socket.userId}`);
    socket.join(`user:${socket.userId}`);

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

    // Auto-join all conversation rooms for this user so they receive
    // broadcasts (like reactions) without needing to manually open each conversation.
    try {
      const allConvs = await Conversation.find({
        participants: socket.userId,
      }).select("_id type");

      for (const conv of allConvs) {
        socket.join(`conv:${conv._id}`);
      }
    } catch (err) {
      console.error("Conversation room auto-join error:", err.message);
    }

    // Auto-join all workspace rooms for this user
    try {
      const userWorkspaces = await Workspace.find({
        "members.user": socket.userId,
      }).select("_id");

      for (const ws of userWorkspaces) {
        socket.join(`workspace:${ws._id}`);
      }
    } catch (err) {
      console.error("Workspace room auto-join error:", err.message);
    }

    // Delegate event handling to focused modules
    registerMessageHandlers(socket, { ...helpers, io });
    registerConversationHandlers(socket, { ...helpers, io });
    const { cleanup: cleanupTyping } = registerTypingHandlers(socket, {
      ...helpers,
      io,
    });
    registerWorkspaceHandlers(socket, { ...helpers, io });
    const { cleanup: cleanupModules } = registerModuleHandlers(socket, {
      ...helpers,
      io,
    });
    registerFeedHandlers(socket);
    registerCallHandlers(socket, { ...helpers, io });
    registerVoiceChannelHandlers(socket, { io });
    const { handleDisconnect: wordSpyDisconnect } = registerWordSpyHandlers(socket, { ...helpers, io });

    // ----------------------------------------------------------------
    // Handle disconnection — clean up Redis mapping
    // ----------------------------------------------------------------
    socket.on("disconnect", async () => {
      console.log(
        `❌ User disconnected: ${socket.id} (userId: ${socket.userId})`,
      );

      cleanupPresence();
      await cleanupTyping();
      cleanupModules();
      if (wordSpyDisconnect) await wordSpyDisconnect();

      if (getIsRedisConnected()) {
        try {
          // Remove only this socket from the SET (other tabs remain)
          await redisClient.sRem(`sockets:${socket.userId}`, socket.id);

          // Only mark offline when no sockets remain for this user
          const remainingSockets = await redisClient.sCard(
            `sockets:${socket.userId}`,
          );

          if (remainingSockets === 0) {
            const disconnectTime = Date.now();
            await redisClient.set(`lastSeen:${socket.userId}`, disconnectTime.toString(), {
              EX: 604800,
            });

            // Persist to DB separately — isolate errors from Redis path
            try {
              await User.findByIdAndUpdate(socket.userId, { lastSeen: disconnectTime });
            } catch (dbErr) {
              console.error(`Failed to update User.lastSeen for ${socket.userId}:`, dbErr.message);
            }

            await redisClient.del(`presence:${socket.userId}`);

            io.emit("presence:update", {
              userId: socket.userId,
              online: false,
              lastSeen: disconnectTime,
            });
          }
        } catch (err) {
          console.error("Redis disconnect error:", err);
        }
      }
    });
  });
};

module.exports = socketHandler;
