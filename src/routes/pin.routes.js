const express = require("express");
const router = express.Router({ mergeParams: true }); // Important for nested routes
const {
  pinMessage,
  unpinMessage,
  getPinnedMessages,
} = require("../controllers/pin.controller");
const auth = require("../middleware/auth.middleware");
const {
  loadConversation,
  isParticipant,
} = require("../middleware/group.middleware"); // ← Changed this line

// All routes require auth and conversation loading
router.use(auth);
router.use(loadConversation);
router.use(isParticipant);

// GET /api/chat/conversations/:id/pins
router.get("/pins", getPinnedMessages);

// POST /api/chat/conversations/:id/messages/:messageId/pin
router.post("/messages/:messageId/pin", pinMessage);

// DELETE /api/chat/conversations/:id/messages/:messageId/pin
router.delete("/messages/:messageId/pin", unpinMessage);

module.exports = router;
