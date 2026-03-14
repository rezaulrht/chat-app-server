const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth.middleware");

const {
  getPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  reactToPost,
} = require("../controllers/feed.controller");

// All routes require authentication
router.use(auth);

// @route   GET /api/feed/posts
// @desc    Get paginated feed posts
// @access  Any authenticated user
router.get("/", getPosts);

// @route   GET /api/feed/posts/:id
// @desc    Get a single feed post
// @access  Any authenticated user
router.get("/:id", getPost);

// @route   POST /api/feed/posts
// @desc    Create a new feed post
// @access  Any authenticated user
router.post("/", createPost);

// @route   PATCH /api/feed/posts/:id
// @desc    Update an owned feed post
// @access  Post owner only
router.patch("/:id", updatePost);

// @route   DELETE /api/feed/posts/:id
// @desc    Delete an owned feed post
// @access  Post owner only
router.delete("/:id", deletePost);

// @route   POST /api/feed/posts/:id/react
// @desc    Toggle a reaction emoji on a post
// @access  Authenticated
router.post("/:id/react", reactToPost);

module.exports = router;
