// chat-app-server/src/routes/upload.routes.js
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const { presign } = require("../controllers/upload.controller");
const { uploadAvatar } = require("../controllers/upload.controller");
const auth = require("../middleware/auth.middleware");

// POST /api/upload/avatar
router.post("/presign", authMiddleware, presign);
router.post("/avatar", auth, uploadAvatar);

module.exports = router;
