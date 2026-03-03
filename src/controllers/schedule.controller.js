const ScheduledMessage = require("../models/ScheduledMessage");
const Message = require("../models/Message");
const { redisClient } = require("../config/redis");
const { v4: uuidv4 } = require("uuid");

/**
 * CREATE SCHEDULE
 */
exports.createScheduledMessage = async (req, res) => {
  try {
    const { conversationId, content, sendAt } = req.body;

    const idempotencyKey = uuidv4();

    const scheduled = await ScheduledMessage.create({
      conversationId,
      senderId: req.user._id,
      content,
      sendAt,
      idempotencyKey,
    });

    await redisClient.zAdd("sched:messages", {
      score: new Date(sendAt).getTime(),
      value: scheduled._id.toString(),
    });

    res.status(201).json(scheduled);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * CANCEL
 */
exports.cancelScheduledMessage = async (req, res) => {
  const { id } = req.params;

  const scheduled = await ScheduledMessage.findById(id);

  if (!scheduled || scheduled.status !== "scheduled") {
    return res.status(400).json({ error: "Cannot cancel" });
  }

  scheduled.status = "cancelled";
  await scheduled.save();

  await redisClient.zRem("sched:messages", id);

  res.json({ success: true });
};

/**
 * EDIT
 */
exports.editScheduledMessage = async (req, res) => {
  const { id } = req.params;
  const { content, sendAt } = req.body;

  const scheduled = await ScheduledMessage.findById(id);

  if (!scheduled || scheduled.status !== "scheduled") {
    return res.status(400).json({ error: "Cannot edit" });
  }

  if (content) scheduled.content = content;
  if (sendAt) {
    scheduled.sendAt = sendAt;

    await redisClient.zAdd("sched:messages", {
      score: new Date(sendAt).getTime(),
      value: id,
    });
  }

  await scheduled.save();

  res.json(scheduled);
};
