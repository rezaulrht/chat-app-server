const express = require("express");
const router = express.Router();
const {
  sendResetEmail,
  resetPassword,
} = require("../controllers/reset.controller");

// @route   POST /api/reset/forgot-password
router.post("/forgot-password", sendResetEmail);

// @route   POST /api/reset/reset-password
router.post("/reset-password", resetPassword);

module.exports = router;
