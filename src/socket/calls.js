const CallLog = require("../models/CallLog");
const Message = require("../models/Message");
const NotificationService = require("../services/notification.service");
const createHelpers = require("./helpers");

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

      // Tell the initiator to now connect to LiveKit (both join at the same time)
      io.to(`user:${callLog.initiator}`).emit("call:accepted", {
        callId,
        roomName: callLog.livekitRoomName,
        callType: callLog.callType,
      });
    } catch (error) {
      console.error("call:accepted error:", error);
    }
  });

  // call:declined - Recipient declines the call
  socket.on("call:declined", async ({ callId }) => {
    try {
      const callLog = await CallLog.findById(callId).populate(
        "initiator",
        "name",
      );
      if (!callLog) return;

      callLog.participants.push({ userId: socket.userId, status: "declined" });
      callLog.status = "missed";
      callLog.endedAt = new Date();
      await callLog.save();

      if (callLog.conversationId) {
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
      }

      await emitToUser(callLog.initiator._id.toString(), "call:declined", {
        callId,
      });

      // Notify the recipient (socket.userId) that they missed a call from the initiator
      const { emitToUser: emitFn } = createHelpers(io);
      await NotificationService.push(emitFn, {
        recipientId: socket.userId,
        type: "call_missed",
        actorId: callLog.initiator._id.toString(),
        data: { conversationId: callLog.conversationId?.toString() },
      });
    } catch (error) {
      console.error("call:declined error:", error);
    }
  });

  // call:ended - Any participant ends the call
  socket.on("call:ended", async ({ callId }) => {
    try {
      const callLog = await CallLog.findById(callId).populate(
        "initiator",
        "_id",
      );
      if (!callLog) return;

      const alreadyEnded = callLog.status !== "active";
      const duration =
        callLog.duration ||
        (callLog.startedAt
          ? Math.floor(
              (Date.now() - new Date(callLog.startedAt).getTime()) / 1000,
            )
          : 0);

      // Only update DB if still active
      if (!alreadyEnded) {
        callLog.endedAt = new Date();
        callLog.duration = duration;
        callLog.status = "ended";
        await callLog.save();

        if (callLog.conversationId) {
          const callMessage = await Message.create({
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

          // Populate sender so the client can render it immediately
          await callMessage.populate("sender", "name avatar");

          // Push to chat in real time — same event ChatWindow listens to
          io.to(`conv:${callLog.conversationId}`).emit(
            "message:new",
            callMessage.toObject(),
          );
        }
      }

      // Always notify all participants so both sides clear the call UI
      if (callLog.conversationId) {
        io.to(`conv:${callLog.conversationId}`).emit("call:ended", {
          callId,
          duration,
        });
      } else {
        const initiatorIdStr = callLog.initiator._id.toString();
        const participantIds = new Set(
          callLog.participants.map((p) => p.userId.toString()),
        );

        callLog.participants.forEach((p) => {
          io.to(`user:${p.userId}`).emit("call:ended", { callId, duration });
        });

        // Notify initiator only if not already in participants list
        if (!participantIds.has(initiatorIdStr)) {
          io.to(`user:${initiatorIdStr}`).emit("call:ended", {
            callId,
            duration,
          });
        }
      }
    } catch (error) {
      console.error("call:ended error:", error);
    }
  });
};

module.exports = registerCallHandlers;
