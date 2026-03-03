// src/utility/scheduler.js

const ScheduledMessage = require("../models/ScheduledMessage");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { redisClient, getIsRedisConnected } = require("../config/redis");
const createHelpers = require("../socket/helpers");

// Redis lock to prevent double-send if multiple server instances run
async function acquireLock(jobId, ttlMs = 15000) {
  const lockKey = `lock:sched:${jobId}`;
  const ok = await redisClient.set(lockKey, "1", { NX: true, PX: ttlMs });
  return ok === "OK";
}
async function releaseLock(jobId) {
  const lockKey = `lock:sched:${jobId}`;
  await redisClient.del(lockKey);
}

// Build payload consistent with your normal socket message payload
function buildMessagePayload(message) {
  return {
    _id: message._id,
    conversationId: message.conversationId,
    sender: message.sender,
    receiverId: message.receiverId,
    text: message.text,
    status: message.status,
    createdAt: message.createdAt,
    scheduledFromId: message.scheduledFromId,
    // include optional fields if your schema uses them (harmless if undefined)
    gifUrl: message.gifUrl,
    replyTo: message.replyTo || null,
    deliveredAt: message.deliveredAt,
    readAt: message.readAt,
  };
}

function startScheduler(io) {
  const { emitToUser } = createHelpers(io);

  setInterval(async () => {
    if (!getIsRedisConnected()) return;

    try {
      const now = Date.now();

      // Get due jobs (ids stored as zset values)
      const jobs = await redisClient.zRangeByScore("sched:messages", 0, now);

      for (const jobId of jobs) {
        const locked = await acquireLock(jobId);
        if (!locked) continue;

        try {
          const scheduled = await ScheduledMessage.findById(jobId);

          // If missing or already processed, remove from queue
          if (!scheduled) {
            await redisClient.zRem("sched:messages", jobId);
            continue;
          }
          if (scheduled.status !== "scheduled") {
            await redisClient.zRem("sched:messages", jobId);
            continue;
          }

          // Load conversation to decide DM vs Group and participants
          const conversation = await Conversation.findById(
            scheduled.conversationId,
          );

          if (!conversation) {
            scheduled.status = "failed";
            scheduled.lastError = "Conversation not found";
            scheduled.attempts = (scheduled.attempts || 0) + 1;
            await scheduled.save();
            await redisClient.zRem("sched:messages", jobId);
            continue;
          }

          const isGroup = conversation.type === "group";
          const participants = (conversation.participants || []).map((p) =>
            p.toString(),
          );

          // Mark sending
          scheduled.status = "sending";
          await scheduled.save();

          // Find receiver for DM
          let receiverId = null;
          if (!isGroup) {
            receiverId =
              participants.find((p) => p !== scheduled.senderId.toString()) ||
              null;
          }

          // Create Message using your schema fields
          const message = await Message.create({
            conversationId: scheduled.conversationId,
            sender: scheduled.senderId,
            receiverId,
            text: scheduled.content,
            status: "sent",
            scheduledFromId: scheduled._id,
          });

          const payload = buildMessagePayload(message);

          // Emit to users using your Redis socket mapping
          if (isGroup) {
            // Send to all participants (including sender so their UI updates)
            for (const uid of participants) {
              await emitToUser(uid, "message:new", payload);
            }
          } else {
            // DM: send to sender + receiver
            await emitToUser(
              scheduled.senderId.toString(),
              "message:new",
              payload,
            );
            if (receiverId) {
              await emitToUser(receiverId.toString(), "message:new", payload);
            }
          }

          // Mark sent + remove from queue
          scheduled.status = "sent";
          await scheduled.save();
          await redisClient.zRem("sched:messages", jobId);
        } catch (err) {
          console.error("Scheduler job error:", err);

          // Mark failed and remove from redis to avoid infinite retry loop
          try {
            await ScheduledMessage.findByIdAndUpdate(jobId, {
              $inc: { attempts: 1 },
              $set: { status: "failed", lastError: err.message },
            });
            await redisClient.zRem("sched:messages", jobId);
          } catch (_) {}
        } finally {
          await releaseLock(jobId);
        }
      }
    } catch (err) {
      console.error("Scheduler tick error:", err);
    }
  }, 2000);
}

module.exports = startScheduler;
