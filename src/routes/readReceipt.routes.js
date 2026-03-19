const express = require("express");
const router = express.Router();

const {
  markMessageAsRead,
  markMultipleAsRead,
} = require("../controllers/readReceipt.controller");

const auth = require("../middleware/auth.middleware");

// POST /api/chat/messages/:messageId/read
router.post("/messages/:messageId/read", auth, markMessageAsRead);

// POST /api/chat/conversations/:conversationId/messages/read-bulk
router.post(
  "/conversations/:conversationId/messages/read-bulk",
  auth,
  markMultipleAsRead,
);

module.exports = router;
