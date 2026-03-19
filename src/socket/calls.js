const CallLog = require("../models/CallLog");
const Message = require("../models/Message");

const registerCallHandlers = (socket, { emitToUser, io }) => {
  // call:accepted - Recipient accepts the call
  socket.on("call:accepted", async ({ callId }) => {
    try {
      const callLog = await CallLog.findById(callId);
      if (!callLog || callLog.status !== "active") return;

      callLog.participants.push({
        userId: socket.userId,
        joinedAt: new Date(),
        status: "joined",
      });
      await callLog.save();

      io.to(`conv:${callLog.conversationId}`).emit("call:user_joined", {
        callId,
        userId: socket.userId,
      });
    } catch (error) {
      console.error("call:accepted error:", error);
    }
  });

  // call:declined - Recipient declines the call
  socket.on("call:declined", async ({ callId }) => {
    try {
      const callLog = await CallLog.findById(callId).populate("initiator", "name");
      if (!callLog) return;

      callLog.participants.push({ userId: socket.userId, status: "declined" });
      callLog.status = "missed";
      callLog.endedAt = new Date();
      await callLog.save();

      await Message.create({
        conversationId: callLog.conversationId,
        sender: callLog.initiator._id,
        callLog: {
          callType: callLog.callType,
          duration: 0,
          status: "declined",
          initiator: callLog.initiator._id,
          participants: [callLog.initiator._id],
        },
      });

      await emitToUser(callLog.initiator._id.toString(), "call:declined", { callId });
    } catch (error) {
      console.error("call:declined error:", error);
    }
  });

  // call:ended - Any participant ends the call
  socket.on("call:ended", async ({ callId }) => {
    try {
      const callLog = await CallLog.findById(callId).populate("initiator", "_id");
      if (!callLog || callLog.status !== "active") return;

      const duration = Math.floor((Date.now() - callLog.startedAt) / 1000);
      callLog.endedAt = new Date();
      callLog.duration = duration;
      callLog.status = "ended";
      await callLog.save();

      await Message.create({
        conversationId: callLog.conversationId,
        sender: callLog.initiator._id,
        callLog: {
          callType: callLog.callType,
          duration,
          status: "ended",
          initiator: callLog.initiator._id,
          participants: callLog.participants.map((p) => p.userId),
        },
      });

      io.to(`conv:${callLog.conversationId}`).emit("call:ended", { callId, duration });
    } catch (error) {
      console.error("call:ended error:", error);
    }
  });
};

module.exports = registerCallHandlers;
