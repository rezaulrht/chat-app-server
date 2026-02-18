/**
 * Socket.io event handlers and configuration
 */

const jwt = require("jsonwebtoken");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

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

  io.on("connection", async (socket) => {
    console.log(`✅ User connected: ${socket.id} (userId: ${socket.userId})`);

    // --- Register userId -> socketId in Redis (or in-memory fallback) ---
    if (getIsRedisConnected()) {
      await redisClient.set(`socket:${socket.userId}`, socket.id, { EX: 86400 });
    } else {
      // In-memory fallback map stored on the io instance
      if (!io._userSockets) io._userSockets = {};
      io._userSockets[socket.userId] = socket.id;
    }

    // --- 1-to-1 message:send ---
    // Client emits: { conversationId, receiverId, text }
    socket.on("message:send", async ({ conversationId, receiverId, text }) => {
      if (!conversationId || !receiverId || !text?.trim()) return;

      try {
        // 1. Save message to MongoDB
        const message = await Message.create({
          conversationId,
          sender: socket.userId,
          text: text.trim(),
          status: "sent",
        });

        // Populate sender info for the response
        await message.populate("sender", "name avatar");

        // 2. Update conversation's lastMessage
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: {
            text: message.text,
            sender: socket.userId,
            timestamp: message.createdAt,
          },
        });

        // 3. Shape the payload both sides will receive
        const payload = {
          _id: message._id,
          conversationId,
          sender: message.sender,
          text: message.text,
          status: message.status,
          createdAt: message.createdAt,
        };

        // 4. Deliver to receiver if they are online
        let receiverSocketId = null;

        if (getIsRedisConnected()) {
          receiverSocketId = await redisClient.get(`socket:${receiverId}`);
        } else if (io._userSockets) {
          receiverSocketId = io._userSockets[receiverId];
        }

        if (receiverSocketId) {
          io.to(receiverSocketId).emit("message:receive", payload);
        }

        // 5. Ack back to sender with the saved message
        socket.emit("message:delivered", payload);
      } catch (err) {
        console.error("message:send error:", err.message);
        socket.emit("message:error", { error: "Failed to send message" });
      }
    });

    // --- Disconnection: remove userId -> socketId mapping ---
    socket.on("disconnect", async () => {
      console.log(`❌ User disconnected: ${socket.id} (userId: ${socket.userId})`);

      if (getIsRedisConnected()) {
        await redisClient.del(`socket:${socket.userId}`);
      } else if (io._userSockets) {
        delete io._userSockets[socket.userId];
      }
    });
  });
};

module.exports = socketHandler;
