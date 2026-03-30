const NotificationService = require("../services/notification.service");
const User = require("../models/User");

// @desc   Get paginated notifications for the logged-in user
exports.getNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await NotificationService.getForUser(req.user.id, page, limit);
    res.json(result);
  } catch (err) {
    console.error("getNotifications error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc   Mark one notification as read
exports.markRead = async (req, res) => {
  try {
    const notif = await NotificationService.markRead(req.user.id, req.params.id);
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error("markRead error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc   Mark all notifications as read
exports.markAllRead = async (req, res) => {
  try {
    await NotificationService.markAllRead(req.user.id);
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("markAllRead error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc   Delete a notification
exports.deleteNotification = async (req, res) => {
  try {
    const deleted = await NotificationService.deleteOne(req.user.id, req.params.id);
    if (!deleted) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Notification deleted" });
  } catch (err) {
    console.error("deleteNotification error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc   Get notification preferences
exports.getPrefs = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("notificationPrefs").lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ prefs: user.notificationPrefs || {} });
  } catch (err) {
    console.error("getPrefs error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc   Update notification preferences
exports.updatePrefs = async (req, res) => {
  try {
    const allowed = [
      "chat_message", "chat_mention", "call_missed",
      "feed_reaction", "feed_comment", "feed_follow", "workspace_mention",
    ];
    const update = {};
    for (const key of allowed) {
      if (typeof req.body[key] === "boolean") {
        update[`notificationPrefs.${key}`] = req.body[key];
      }
    }
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true, select: "notificationPrefs" }
    ).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ prefs: user.notificationPrefs });
  } catch (err) {
    console.error("updatePrefs error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
