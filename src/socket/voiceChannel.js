const Module = require("../models/Module");

const registerVoiceChannelHandlers = (socket, { io }) => {
  socket.on("voice_channel:join", async ({ moduleId, workspaceId }) => {
    try {
      const module = await Module.findById(moduleId);
      if (!module || !module.isVoiceChannel) return;

      module.activeParticipants.push({ userId: socket.userId, joinedAt: new Date() });
      await module.save();

      socket.join(`voice-channel-${moduleId}`);

      io.to(`voice-channel-${moduleId}`).emit("voice_channel:participants", {
        moduleId,
        participants: module.activeParticipants,
      });
    } catch (error) {
      console.error("voice_channel:join error:", error);
    }
  });

  socket.on("voice_channel:leave", async ({ moduleId }) => {
    try {
      const module = await Module.findById(moduleId);
      if (!module) return;

      module.activeParticipants = module.activeParticipants.filter(
        (p) => p.userId.toString() !== socket.userId.toString()
      );
      await module.save();

      socket.leave(`voice-channel-${moduleId}`);

      io.to(`voice-channel-${moduleId}`).emit("voice_channel:participants", {
        moduleId,
        participants: module.activeParticipants,
      });
    } catch (error) {
      console.error("voice_channel:leave error:", error);
    }
  });
};

module.exports = registerVoiceChannelHandlers;
