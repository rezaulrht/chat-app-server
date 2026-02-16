/**
 * Socket.io event handlers and configuration
 */

const socketHandler = (io) => {
  io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Test event listener
    socket.on("test-message", (data) => {
      console.log("Received test message:", data);
      socket.emit("test-response", { message: "Message received!", data });
    });

    // Broadcast to all clients
    socket.on("broadcast", (data) => {
      console.log("Broadcasting:", data);
      io.emit("broadcast-message", data);
    });

    // Handle disconnection
    socket.on("disconnect", () => {
      console.log(`❌ User disconnected: ${socket.id}`);
    });
  });
};

module.exports = socketHandler;
