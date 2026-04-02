const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");

// @route   GET /api/user/:id
// @desc    Get public profile for a user
// @access  Private
router.get("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "name avatar bio statusMessage banner bannerColor createdAt"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      _id: user._id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      statusMessage: user.statusMessage,
      banner: user.banner,
      bannerColor: user.bannerColor,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error("Get user profile error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
