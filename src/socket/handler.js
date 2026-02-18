/**
 * Socket.io event handlers and configuration
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");

const socketHandler = (io) => {
  // --- Socket Authentication Middleware ---
  // Runs before every connection is established.
  // Client must pass the JWT as: socket = io(URL, { auth: { token: "..." } })
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id; // attach userId to the socket instance
      next();
    } catch (err) {
      return next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id} (userId: ${socket.userId})`);

    // Test event listener
    socket.on("test-message", async (data) => {
      console.log("Received test message:", data);

      if (getIsRedisConnected()) {
        try {
          // Save test message in Redis
          await redisClient.set(
            `test:${socket.id}`,
            JSON.stringify(data),
            { EX: 60 }, // auto expire after 60s
          );

          const check = await redisClient.get(`test:${socket.id}`);
          console.log("Redis Stored Value:", check);
        } catch (err) {
          console.error("Redis Operation Error:", err);
        }
      }

      socket.emit("test-response", {
        message: "Message received!",
        data,
      });
    });

    // Broadcast to all clients
    socket.on("broadcast", async (data) => {
      console.log("Broadcasting:", data);

      if (getIsRedisConnected()) {
        try {
          // Store broadcast message in Redis list
          await redisClient.rPush("broadcast:messages", JSON.stringify(data));

          // Keep only last 50 broadcasts
          await redisClient.lTrim("broadcast:messages", -50, -1);
        } catch (err) {
          console.error("Redis Operation Error:", err);
        }
      }

      io.emit("broadcast-message", data);
    });

    // Handle disconnection
    socket.on("disconnect", async () => {
      console.log(
        `❌ User disconnected: ${socket.id} (userId: ${socket.userId})`,
      );

      if (getIsRedisConnected()) {
        try {
          await redisClient.del(`test:${socket.id}`);
        } catch (err) {
          console.error("Redis Operation Error:", err);
        }
      }
    });
  });
};

module.exports = socketHandler;
