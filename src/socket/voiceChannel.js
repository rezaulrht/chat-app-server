const Module = require("../models/Module");

const registerVoiceChannelHandlers = (socket, { io }) => {
  socket.on("voice_channel:join", async ({ moduleId, workspaceId }) => {
    try {
      const voiceModule = await Module.findById(moduleId);
      if (!voiceModule || voiceModule.type !== "voice") return;

      // Deduplicate — remove existing entry for this user before re-adding
      voiceModule.activeParticipants = voiceModule.activeParticipants.filter(
        (p) => p.userId.toString() !== socket.userId.toString(),
      );
      voiceModule.activeParticipants.push({
        userId: socket.userId,
        joinedAt: new Date(),
      });
      await voiceModule.save();

      socket.join(`voice-channel-${moduleId}`);

      // Populate user info so clients can show names/avatars
      const populated = await Module.findById(moduleId).populate(
        "activeParticipants.userId",
        "name avatar",
      );

      io.to(`voice-channel-${moduleId}`).emit("voice_channel:participants", {
        moduleId,
        participants: populated.activeParticipants,
      });
    } catch (error) {
      console.error("voice_channel:join error:", error);
    }
  });

  socket.on("voice_channel:leave", async ({ moduleId }) => {
    try {
      const voiceModule = await Module.findById(moduleId);
      if (!voiceModule) return;

      voiceModule.activeParticipants = voiceModule.activeParticipants.filter(
        (p) => p.userId.toString() !== socket.userId.toString(),
      );
      await voiceModule.save();

      socket.leave(`voice-channel-${moduleId}`);

      // Populate user info so clients can show names/avatars
      const populated = await Module.findById(moduleId).populate(
        "activeParticipants.userId",
        "name avatar",
      );

      io.to(`voice-channel-${moduleId}`).emit("voice_channel:participants", {
        moduleId,
        participants: populated.activeParticipants,
      });
    } catch (error) {
      console.error("voice_channel:leave error:", error);
    }
  });

  // Clean up on unexpected disconnect
  socket.on("disconnect", async () => {
    try {
      const modules = await Module.find({
        type: "voice",
        "activeParticipants.userId": socket.userId,
      });
      for (const voiceModule of modules) {
        voiceModule.activeParticipants = voiceModule.activeParticipants.filter(
          (p) => p.userId.toString() !== socket.userId.toString(),
        );
        await voiceModule.save();
        const populated = await Module.findById(voiceModule._id).populate(
          "activeParticipants.userId",
          "name avatar",
        );
        io.to(`voice-channel-${voiceModule._id}`).emit(
          "voice_channel:participants",
          {
            moduleId: voiceModule._id,
            participants: populated.activeParticipants,
          },
        );
      }
    } catch (err) {
      console.error(
        "[voiceChannel] disconnect cleanup error for user",
        socket.userId,
        err,
      );
    }
  });
};

module.exports = registerVoiceChannelHandlers;
