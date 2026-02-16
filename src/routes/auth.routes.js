const express = require("express");
const router = express.Router();
const { register, login, me } = require("../controllers/auth.controller");
const auth = require("../middleware/auth.middleware");

// @route   POST /auth/register
router.post("/register", register);

// @route   POST /auth/login
router.post("/login", login);

// @route   GET /auth/me
router.get("/me", auth, me);

module.exports = router;
