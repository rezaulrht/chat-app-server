const ScheduledMessage = require("../models/ScheduledMessage");
const RedisConfig = require("../config/redis");
const { v4: uuidv4 } = require("uuid");

// ✅ Support both export styles:
// - redisClient is the actual connected client
// - OR redisClient() returns the client (getter style)
function getRedisClient() {
  const rc = RedisConfig.redisClient;
  if (!rc) return null;
  return typeof rc === "function" ? rc() : rc;
}

// ✅ Your auth.middleware sets req.user = decoded; decoded.id
function getAuthUserId(req) {
  return req?.user?.id || req?.user?._id || req?.user?.userId;
}

function ensureObjectIdString(x) {
  return x ? x.toString() : "";
}

/**
 * CREATE schedule
 * body: { conversationId, content, sendAt, idempotencyKey? }
 */
exports.createScheduledMessage = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { conversationId, content, sendAt, idempotencyKey } = req.body;

    if (!conversationId || !content || !sendAt) {
      return res
        .status(400)
        .json({ error: "conversationId, content, sendAt are required" });
    }

    const sendTime = new Date(sendAt);
    if (isNaN(sendTime.getTime())) {
      return res.status(400).json({ error: "Invalid sendAt date" });
    }

    const key = idempotencyKey || uuidv4();

    // Idempotency: if same key already exists, return it
    const existing = await ScheduledMessage.findOne({ idempotencyKey: key });
    if (existing) return res.status(200).json(existing);

    const scheduled = await ScheduledMessage.create({
      conversationId,
      senderId: userId,
      content: content.trim(),
      sendAt: sendTime,
      idempotencyKey: key,
    });

    const client = getRedisClient();
    if (!client) {
      // still return created scheduled message even if redis is down
      // (scheduler won't run until redis is up)
      return res.status(201).json({
        ...scheduled.toObject(),
        warning: "Redis not connected; scheduling queue not updated",
      });
    }

    await client.zAdd("sched:messages", {
      score: sendTime.getTime(),
      value: scheduled._id.toString(),
    });

    return res.status(201).json(scheduled);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * LIST scheduled messages for a conversation
 * query: ?conversationId=...
 */
exports.listScheduledMessages = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { conversationId } = req.query;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const rows = await ScheduledMessage.find({
      conversationId,
      senderId: userId, // only yours
      status: { $in: ["scheduled", "sending"] },
    }).sort({ sendAt: 1 });

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET one scheduled message
 */
exports.getScheduledMessage = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const scheduled = await ScheduledMessage.findById(id);

    if (!scheduled) return res.status(404).json({ error: "Not found" });

    // ✅ FIX: use userId (not req.user._id)
    if (
      ensureObjectIdString(scheduled.senderId) !== ensureObjectIdString(userId)
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(scheduled);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * EDIT scheduled message
 * body: { content?, sendAt? }
 */
exports.editScheduledMessage = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const { content, sendAt } = req.body;

    const scheduled = await ScheduledMessage.findById(id);
    if (!scheduled) return res.status(404).json({ error: "Not found" });

    // ✅ FIX: use userId (not req.user._id)
    if (
      ensureObjectIdString(scheduled.senderId) !== ensureObjectIdString(userId)
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (scheduled.status !== "scheduled") {
      return res.status(400).json({ error: "Cannot edit (already processed)" });
    }

    if (typeof content === "string" && content.trim()) {
      scheduled.content = content.trim();
    }

    const client = getRedisClient();

    if (sendAt) {
      const sendTime = new Date(sendAt);
      if (isNaN(sendTime.getTime())) {
        return res.status(400).json({ error: "Invalid sendAt date" });
      }

      scheduled.sendAt = sendTime;

      if (client) {
        await client.zAdd("sched:messages", {
          score: sendTime.getTime(),
          value: scheduled._id.toString(),
        });
      }
    }

    await scheduled.save();
    return res.json(scheduled);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * CANCEL scheduled message
 */
exports.cancelScheduledMessage = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;

    const scheduled = await ScheduledMessage.findById(id);
    if (!scheduled) return res.status(404).json({ error: "Not found" });

    // ✅ FIX: use userId (not req.user._id)
    if (
      ensureObjectIdString(scheduled.senderId) !== ensureObjectIdString(userId)
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (scheduled.status !== "scheduled") {
      return res
        .status(400)
        .json({ error: "Cannot cancel (already processed)" });
    }

    scheduled.status = "cancelled";
    await scheduled.save();

    const client = getRedisClient();
    if (client) {
      await client.zRem("sched:messages", scheduled._id.toString());
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
