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

    // Store userId -> socketId mapping in Redis so we can route messages
    if (getIsRedisConnected()) {
      try {
        await redisClient.set(`socket:${socket.userId}`, socket.id, {
          EX: 86400,
        });
      } catch (err) {
        console.error("Redis set socket error:", err);
      }
    }

    // ----------------------------------------------------------------
    // message:send
    // Client emits: { conversationId, receiverId, text }
    // ----------------------------------------------------------------
    socket.on(
      "message:send",
      async ({ conversationId, receiverId, text, tempId }) => {
        if (!conversationId || !receiverId || !text?.trim()) return;

        try {
          // 1. Save message to MongoDB
          const message = await Message.create({
            conversationId,
            sender: socket.userId,
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
            text: message.text,
            status: message.status,
            createdAt: message.createdAt,
          };

          // 4. Deliver to receiver if they are online
          let receiverSocketId = null;
          if (getIsRedisConnected()) {
            try {
              receiverSocketId = await redisClient.get(`socket:${receiverId}`);
            } catch (err) {
              console.error("Redis get receiver socket error:", err);
            }
          }

          if (receiverSocketId) {
            io.to(receiverSocketId).emit("message:receive", payload);
          }

          // 5. Ack back to sender with the saved message (so client gets real _id + createdAt)
          socket.emit("message:delivered", payload);
        } catch (err) {
          console.error("message:send error:", err.message);
          socket.emit("message:error", { message: "Failed to send message" });
        }
      },
    );

    // ----------------------------------------------------------------
    // Handle disconnection — clean up Redis mapping
    // ----------------------------------------------------------------
    socket.on("disconnect", async () => {
      console.log(
        `❌ User disconnected: ${socket.id} (userId: ${socket.userId})`,
      );

      if (getIsRedisConnected()) {
        try {
          await redisClient.del(`socket:${socket.userId}`);
        } catch (err) {
          console.error("Redis del socket error:", err);
        }
      }
    });
  });
};

module.exports = socketHandler;
