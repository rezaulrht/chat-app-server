const Notification = require("../models/Notification");
const User = require("../models/User");

const GROUPING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Maps notification type → the User.notificationPrefs key to check
const PREF_KEY = {
  chat_message:       "chat_message",
  chat_mention:       "chat_mention",
  call_missed:        "call_missed",
  feed_reaction:      "feed_reaction",
  feed_comment:       "feed_comment",
  feed_follow:        "feed_follow",
  feed_answer_accepted: "feed_comment", // shares the feed_comment pref
  workspace_mention:  "workspace_mention",
};

// Maps notification type → the data field used as the grouping target key
const GROUP_KEY = {
  chat_message:     "conversationId",
  chat_mention:     "conversationId",
  feed_reaction:    "postId",
  feed_comment:     "postId",
  workspace_mention:"moduleId",
};

const NotificationService = {
  /**
   * Create or update (group) a notification and emit it via socket.
   *
   * @param {Function} emitToUser - from createHelpers(io). Handles multi-device delivery.
   * @param {Object}   opts
   * @param {string}   opts.recipientId
   * @param {string}   opts.type        - one of the 8 enum values
   * @param {string}   opts.actorId     - who triggered it (may equal recipientId — skipped)
   * @param {Object}   opts.data        - contextual IDs (conversationId, postId, etc.)
   */
  async push(emitToUser, { recipientId, type, actorId, data = {} }) {
    // 1. No self-notifications
    if (actorId && actorId.toString() === recipientId.toString()) return;

    // 2. Check preference
    const prefKey = PREF_KEY[type];
    if (prefKey) {
      const user = await User.findById(recipientId).select("notificationPrefs").lean();
      if (!user) return;
      const prefs = user.notificationPrefs || {};
      // Defaults to true if the field hasn't been set (existing users before migration)
      if (prefs[prefKey] === false) return;
    }

    // 3. Grouping check
    let notif;
    const groupKey = GROUP_KEY[type];
    const windowStart = new Date(Date.now() - GROUPING_WINDOW_MS);

    if (groupKey && data[groupKey]) {
      notif = await Notification.findOne({
        recipient: recipientId,
        type,
        read: false,
        createdAt: { $gte: windowStart },
        [`data.${groupKey}`]: data[groupKey],
      }).sort({ createdAt: -1 });
    }

    if (notif) {
      // Update existing grouped notification
      if (actorId && !notif.actors.some((a) => a.toString() === actorId.toString())) {
        notif.actors.push(actorId);
      }
      notif.actorCount += 1;
      notif.data = { ...notif.data, ...data };
      await notif.save();
    } else {
      // Create new notification
      notif = await Notification.create({
        recipient: recipientId,
        type,
        actors: actorId ? [actorId] : [],
        actorCount: 1,
        data,
      });
    }

    // 4. Populate actors for delivery
    const populated = await Notification.findById(notif._id)
      .populate("actors", "name avatar")
      .lean();

    // 5. Real-time delivery (no-op if Redis is down)
    if (emitToUser) {
      await emitToUser(recipientId.toString(), "notification:new", populated);
    }

    return populated;
  },

  /**
   * Paginated list for a user, newest first.
   * Returns { notifications, unreadCount, hasMore }
   */
  async getForUser(userId, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ recipient: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("actors", "name avatar")
        .lean(),
      Notification.countDocuments({ recipient: userId }),
      Notification.countDocuments({ recipient: userId, read: false }),
    ]);
    return {
      notifications,
      unreadCount,
      hasMore: skip + notifications.length < total,
    };
  },

  /** Mark one notification as read. Returns null if not found or not owned. */
  async markRead(userId, notifId) {
    const notif = await Notification.findOne({ _id: notifId, recipient: userId });
    if (!notif) return null;
    notif.read = true;
    await notif.save();
    return notif;
  },

  /** Mark all unread notifications as read for a user. */
  async markAllRead(userId) {
    return Notification.updateMany(
      { recipient: userId, read: false },
      { $set: { read: true } }
    );
  },

  /** Delete one notification owned by userId. Returns null if not found. */
  async deleteOne(userId, notifId) {
    return Notification.findOneAndDelete({ _id: notifId, recipient: userId });
  },
};

module.exports = NotificationService;
