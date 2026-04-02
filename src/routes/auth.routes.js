const express = require("express");
const router = express.Router();
const {
  register,
  login,
  me,
  updateMe,
  changePassword,
  oauthCallback,
  verifyOTP,
  resendOTP,
  uploadBanner,
} = require("../controllers/auth.controller");
const auth = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");
const passport = require("passport");

const {
  sendResetEmail,
  verifyResetOTP,
  resetPassword,
} = require("../controllers/reset.controller");

// @route   POST /auth/register
router.post("/register", register);

// @route   POST /auth/login
router.post("/login", login);

// @route   POST /auth/verify-otp
router.post("/verify-otp", verifyOTP);

// @route   POST /auth/resend-otp
router.post("/resend-otp", resendOTP);

// @route   GET /auth/google
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

// @route   GET /auth/google/callback
router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${process.env.SITE_URL}/login-error`,
  }),
  oauthCallback,
);

// @route   GET /auth/github
router.get(
  "/github",
  passport.authenticate("github", { scope: ["user:email"] }),
);

// @route   GET /auth/github/callback
router.get(
  "/github/callback",
  passport.authenticate("github", {
    session: false,
    failureRedirect: `${process.env.SITE_URL}/login-error`,
  }),
  oauthCallback,
);

// @route   GET /auth/me
router.get("/me", auth, me);

// @route   PATCH /auth/me
router.patch("/me", auth, updateMe);

// @route   PATCH /auth/change-password
router.patch("/change-password", auth, changePassword);

// @route   PATCH /auth/me/banner
// @desc    Upload and set user banner with crop data
router.patch("/me/banner", auth, upload.single("image"), uploadBanner);

module.exports = router;
