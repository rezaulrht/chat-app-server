/**
 * Typing indicator handlers
 *
 * Export: registerTypingHandlers(socket, helpers)
 */

const TYPING_AUTO_STOP_MS = 5000;

// Map<"conversationId:userId", TimeoutHandle>
// Module-level so it persists across all socket connections in this process.
const typingTimers = new Map();

const registerTypingHandlers = (socket, { emitToUser }) => {
  // ----------------------------------------------------------------
  // typing:start
  // Client emits: { conversationId, receiverId }
  // ----------------------------------------------------------------
  socket.on("typing:start", async ({ conversationId, receiverId } = {}) => {
    if (!conversationId || !receiverId) return;

    await emitToUser(receiverId, "typing:update", {
      conversationId,
      userId: socket.userId,
      isTyping: true,
    });

    // Reset auto-stop timer so continuous keystrokes keep extending it
    const key = `${conversationId}:${socket.userId}`;
    if (typingTimers.has(key)) {
      clearTimeout(typingTimers.get(key));
    }

    const timer = setTimeout(async () => {
      typingTimers.delete(key);
      await emitToUser(receiverId, "typing:update", {
        conversationId,
        userId: socket.userId,
        isTyping: false,
      });
    }, TYPING_AUTO_STOP_MS);

    typingTimers.set(key, timer);
  });

  // ----------------------------------------------------------------
  // typing:stop
  // Client emits: { conversationId, receiverId }
  // ----------------------------------------------------------------
  socket.on("typing:stop", async ({ conversationId, receiverId } = {}) => {
    if (!conversationId || !receiverId) return;

    // Cancel the auto-stop timer — manual stop takes precedence
    const key = `${conversationId}:${socket.userId}`;
    if (typingTimers.has(key)) {
      clearTimeout(typingTimers.get(key));
      typingTimers.delete(key);
    }

    await emitToUser(receiverId, "typing:update", {
      conversationId,
      userId: socket.userId,
      isTyping: false,
    });
  });
};

module.exports = registerTypingHandlers;
