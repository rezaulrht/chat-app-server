/**
 * Presence management
 *
 * Export: registerPresenceHandlers(socket, io)
 *   - Sets up the refresh interval on connect
 *   - Registers the presence:ping handler
 *   - Returns { refreshPresence, cleanup } so handler.js can call them at
 *     connection-time and disconnect-time respectively
 */

const { redisClient, getIsRedisConnected } = require("../config/redis");

const PRESENCE_TTL_SECONDS = 60;
const PRESENCE_REFRESH_MS = 25000;

const registerPresenceHandlers = (socket, io) => {
  const refreshPresence = async (isInitialConnection = false) => {
    if (!getIsRedisConnected()) return;

    try {
      const presenceKey = `presence:${socket.userId}`;
      const now = Date.now().toString();

      // Check if user was previously offline
      const wasOnline = await redisClient.exists(presenceKey);

      // Set or refresh presence TTL
      await redisClient.set(presenceKey, now, { EX: PRESENCE_TTL_SECONDS });

      // Broadcast only when transitioning from offline → online
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

  // Heartbeat — keeps the presence key alive while the tab is open
  const interval = setInterval(
    () => refreshPresence(false),
    PRESENCE_REFRESH_MS,
  );

  // Client-driven ping as a fallback / supplement
  socket.on("presence:ping", async () => {
    await refreshPresence(false);
  });

  const cleanup = () => clearInterval(interval);

  return { refreshPresence, cleanup };
};

module.exports = registerPresenceHandlers;
