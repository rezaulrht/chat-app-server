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

router.use(auth);

// @route   GET /api/feed/posts
router.get("/", getPosts);

// @route   GET /api/feed/posts/:id
router.get("/:id", getPost);

// @route   POST /api/feed/posts
router.post("/", createPost);

// @route   PATCH /api/feed/posts/:id
router.patch("/:id", updatePost);

// @route   DELETE /api/feed/posts/:id
router.delete("/:id", deletePost);

// @route   POST /api/feed/posts/:id/react
router.post("/:id/react", reactToPost);

module.exports = router;
