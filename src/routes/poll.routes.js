const express = require("express");
const router = express.Router();

const {
  createPoll,
  votePoll,
  getPollResults,
} = require("../controllers/poll.controller");

const auth = require("../middleware/auth.middleware");

// ──────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────

// POST /api/chat/conversations/:conversationId/polls
router.post("/conversations/:conversationId/polls", auth, createPoll);

// POST /api/chat/messages/:messageId/vote
router.post("/messages/:messageId/vote", auth, votePoll);

// GET /api/chat/messages/:messageId/poll/results
router.get("/messages/:messageId/poll/results", auth, getPollResults);

module.exports = router;
