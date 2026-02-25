/**
 * Typing indicator handlers
 *
 * Export: registerTypingHandlers(socket, helpers)
 */

const TYPING_AUTO_STOP_MS = 5000;

const Conversation = require("../models/Conversation");

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

    // Security: ensure the sender is actually a participant of this conversation
    const isParticipant = await Conversation.exists({
      _id: conversationId,
      participants: socket.userId,
    });
    if (!isParticipant) return;

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

    // Store both timer and receiverId so disconnect cleanup knows who to notify
    typingTimers.set(key, { timer, receiverId });
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
      clearTimeout(typingTimers.get(key).timer);
      typingTimers.delete(key);
    }

    await emitToUser(receiverId, "typing:update", {
      conversationId,
      userId: socket.userId,
      isTyping: false,
    });
  });

  // ----------------------------------------------------------------
  // cleanup — called on disconnect
  // Cancels all active typing timers for this user and notifies receivers
  // ----------------------------------------------------------------
  const cleanup = async () => {
    const userSuffix = `:${socket.userId}`;
    for (const [key, { timer, receiverId }] of typingTimers) {
      if (!key.endsWith(userSuffix)) continue;

      clearTimeout(timer);
      typingTimers.delete(key);

      const conversationId = key.slice(0, -userSuffix.length);
      await emitToUser(receiverId, "typing:update", {
        conversationId,
        userId: socket.userId,
        isTyping: false,
      });
    }
  };

  return { cleanup };
};

module.exports = registerTypingHandlers;
