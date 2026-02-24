/**
 * Shared socket utility helpers
 * Factory: call with `io` to get bound helper functions.
 */

const { redisClient, getIsRedisConnected } = require("../config/redis");

const createHelpers = (io) => {
  /**
   * Emit an event to ALL active sockets for a user (multi-tab / multi-device).
   */
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

  /**
   * Returns true if the user has at least one active socket connection.
   */
  const isUserOnline = async (userId) => {
    if (!getIsRedisConnected()) return false;
    try {
      const count = await redisClient.sCard(`sockets:${userId}`);
      return count > 0;
    } catch (err) {
      return false;
    }
  };

  return { emitToUser, isUserOnline };
};

module.exports = createHelpers;
