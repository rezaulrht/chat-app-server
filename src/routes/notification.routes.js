const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const {
  getNotifications,
  markRead,
  markAllRead,
  deleteNotification,
  getPrefs,
  updatePrefs,
} = require("../controllers/notification.controller");

// All notification routes require authentication
router.use(auth);

// @route  GET /api/notifications
// @desc   Paginated list for logged-in user
router.get("/", getNotifications);

// @route  PATCH /api/notifications/read-all  ← must be before /:id/read
// @desc   Mark all as read
router.patch("/read-all", markAllRead);

// @route  PATCH /api/notifications/:id/read
// @desc   Mark one as read
router.patch("/:id/read", markRead);

// @route  GET /api/notifications/prefs
// @desc   Get notification preferences
router.get("/prefs", getPrefs);

// @route  PATCH /api/notifications/prefs
// @desc   Update notification preferences
router.patch("/prefs", updatePrefs);

// @route  DELETE /api/notifications/:id
// @desc   Delete one notification
router.delete("/:id", deleteNotification);

module.exports = router;
