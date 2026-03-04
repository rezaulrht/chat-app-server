const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const scheduleController = require("../controllers/schedule.controller");

// Create a schedule
router.post(
  "/schedule",
  authMiddleware,
  scheduleController.createScheduledMessage,
);

// List schedules in conversation
router.get(
  "/scheduled",
  authMiddleware,
  scheduleController.listScheduledMessages,
);

// Get one schedule
router.get(
  "/scheduled/:id",
  authMiddleware,
  scheduleController.getScheduledMessage,
);

// Edit schedule
router.patch(
  "/scheduled/:id",
  authMiddleware,
  scheduleController.editScheduledMessage,
);

// Cancel schedule
router.delete(
  "/scheduled/:id",
  authMiddleware,
  scheduleController.cancelScheduledMessage,
);

module.exports = router;
