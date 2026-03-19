const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const {
  followUser,
  getUserProfile,
  getUserPosts,
  getTopContributors,
  getFollowers,
} = require("../controllers/feed.controller");

// All routes require authentication
router.use(auth);

// ── Social / User routes ─────────────────────────────────────────────────────

// @route   GET /api/feed/users/top-contributors
// @desc    Leaderboard — top 10 users by reputation
// @access  Authenticated
// NOTE: must be before /:id routes to avoid "top-contributors" being treated as an id
router.get("/top-contributors", getTopContributors);

// @route   GET /api/feed/users/:id/profile
// @desc    Public profile — user info + stats + isFollowing flag
// @access  Authenticated
router.get("/:id/profile", getUserProfile);

// @route   GET /api/feed/users/:id/posts
// @desc    User's published posts (paginated)
// @query   page, limit
// @access  Authenticated
router.get("/:id/posts", getUserPosts);

// @route   POST /api/feed/users/:id/follow
// @desc    Toggle follow / unfollow a user
// @access  Authenticated
router.post("/:id/follow", followUser);
router.get("/:id/followers", getFollowers);

module.exports = router;
