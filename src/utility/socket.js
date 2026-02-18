/**
 * Socket.io event handlers and configuration
 */

const { redisClient } = require("../config/redis");

const socketHandler = (io) => {
  io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Test event listener
    socket.on("test-message", async (data) => {
      console.log("Received test message:", data);

      // Save test message in Redis
      await redisClient.set(
        `test:${socket.id}`,
        JSON.stringify(data),
        { EX: 60 } // auto expire after 60s
      );

      socket.emit("test-response", {
        message: "Message received!",
        data,
      });
    });

    // Broadcast to all clients
    socket.on("broadcast", async (data) => {
      console.log("Broadcasting:", data);

      // Store broadcast message in Redis list
      await redisClient.rPush(
        "broadcast:messages",
        JSON.stringify(data)
      );

      // Keep only last 50 broadcasts
      await redisClient.lTrim("broadcast:messages", -50, -1);

      io.emit("broadcast-message", data);
    });

    // Handle disconnection
    socket.on("disconnect", async () => {
      console.log(`❌ User disconnected: ${socket.id}`);

      // Optional: remove any stored test data
      await redisClient.del(`test:${socket.id}`);
    });
  });
};

module.exports = socketHandler;
