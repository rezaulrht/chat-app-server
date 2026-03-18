const express = require("express");
const router = express.Router();
const { uploadAvatar } = require("../controllers/upload.controller");
const auth = require("../middleware/auth.middleware");

// POST /api/upload/avatar
router.post("/avatar", auth, uploadAvatar);

module.exports = router;
