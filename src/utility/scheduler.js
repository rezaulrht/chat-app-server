const ScheduledMessage = require("../models/ScheduledMessage");
const Message = require("../models/Message");
const { redisClient } = require("../config/redis");

function startScheduler(io) {
  setInterval(async () => {
    const now = Date.now();

    const jobs = await redisClient.zRangeByScore("sched:messages", 0, now);

    for (const jobId of jobs) {
      try {
        const scheduled = await ScheduledMessage.findById(jobId);

        if (!scheduled || scheduled.status !== "scheduled") continue;

        scheduled.status = "sending";
        await scheduled.save();

        const message = await Message.create({
          conversationId: scheduled.conversationId,
          senderId: scheduled.senderId,
          content: scheduled.content,
          scheduledFromId: scheduled._id,
        });

        scheduled.status = "sent";
        await scheduled.save();

        await redisClient.zRem("sched:messages", jobId);

        io.to(scheduled.conversationId.toString()).emit("message:new", message);
      } catch (err) {
        console.error("Scheduler error:", err);
      }
    }
  }, 2000);
}

module.exports = startScheduler;
