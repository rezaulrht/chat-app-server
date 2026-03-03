const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const scheduleController = require("../controllers/schedule.controller");

router.post(
  "/schedule",
  authMiddleware,
  scheduleController.createScheduledMessage,
);

router.patch(
  "/scheduled/:id",
  authMiddleware,
  scheduleController.editScheduledMessage,
);

router.delete(
  "/scheduled/:id",
  authMiddleware,
  scheduleController.cancelScheduledMessage,
);

module.exports = router;
