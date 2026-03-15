const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const {
  getPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  followUser,
  getUserProfile,
  getUserPosts,
  getTopContributors,
} = require("../controllers/feed.controller");

// All routes require authentication
router.use(auth);

// ── Posts ────────────────────────────────────────────────────────────────────

// @route   GET /api/feed/posts
// @desc    Get paginated feed posts (tab=latest|trending|top|following|qa)
// @access  Authenticated
router.get("/", getPosts);

// @route   GET /api/feed/posts/:id
// @desc    Get a single post
// @access  Authenticated
router.get("/:id", getPost);

// @route   POST /api/feed/posts
// @desc    Create a new post
// @access  Authenticated
router.post("/", createPost);

// @route   PATCH /api/feed/posts/:id
// @desc    Update own post
// @access  Post owner only
router.patch("/:id", updatePost);

// @route   DELETE /api/feed/posts/:id
// @desc    Delete own post
// @access  Post owner only
router.delete("/:id", deletePost);

// @route   POST /api/feed/posts/:id/react
// @desc    Toggle a reaction emoji on a post
// @access  Authenticated
router.post("/:id/react", reactToPost);

module.exports = router;
