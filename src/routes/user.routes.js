const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");

// @route   POST /api/user/social-links/init/:provider
// @desc    Initiate social account linking (returns OAuth URL)
// @access  Private
router.post("/social-links/init/:provider", auth, async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ["google", "github"];

    if (!validProviders.includes(provider)) {
      return res.status(400).json({ message: "Invalid provider" });
    }

    // Generate a secure state token that includes the user ID for linking
    const state = crypto.randomBytes(32).toString("hex");
    const stateData = {
      state,
      userId: req.user.id,
      action: "link",
      provider
    };

    // Store state in a temporary in-memory map (in production, use Redis)
    if (!global.linkStates) global.linkStates = new Map();
    global.linkStates.set(state, stateData);

    let authUrl;
    const baseUrl = process.env.BASE_URL || "http://localhost:5000";
    const callbackUrl = `${baseUrl}/api/auth/${provider}/callback`;

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const scopes = encodeURIComponent("openid email profile");
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&scope=${scopes}&state=${state}&access_type=offline&prompt=consent`;
    } else if (provider === "github") {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const scopes = encodeURIComponent("user:email");
      authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${scopes}&state=${state}`;
    }

    res.json({ authUrl });
  } catch (err) {
    console.error("Init social-link error:", err.message);
    res.status(500).json({ message: "Failed to initiate account linking" });
  }
});

// @route   GET /api/user/social-links
// @desc    Get all linked social accounts for current user
// @access  Private
router.get("/social-links", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("socialConnections password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const hasPassword = !!user.password;
    const socialConns = user.socialConnections || {};
    const linkedProviders = Object.keys(socialConns).filter(p => socialConns[p]?.providerId);
    const canUnlink = hasPassword || linkedProviders.length > 1;

    // Sanitize social links (don't expose provider IDs to client)
    const sanitizedLinks = linkedProviders.map(provider => ({
      provider,
      username: socialConns[provider].username,
      connectedAt: socialConns[provider].connectedAt,
      canUnlink
    }));

    res.json({
      socialLinks: sanitizedLinks,
      canAddMore: linkedProviders.length < 2
    });
  } catch (err) {
    console.error("Get social-links error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// @route   DELETE /api/user/social-links/:provider
// @desc    Disconnect a social account
// @access  Private
router.delete("/social-links/:provider", auth, async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ["google", "github"];

    if (!validProviders.includes(provider)) {
      return res.status(400).json({ message: "Invalid provider" });
    }

    const user = await User.findById(req.user.id).select("socialConnections password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const socialConns = user.socialConnections || {};
    
    // Check if provider is linked
    if (!socialConns[provider]?.providerId) {
      return res.status(400).json({ message: `${provider} is not linked` });
    }

    // Safety check: ensure user can unlink
    const hasPassword = !!user.password;
    const linkedProviders = Object.keys(socialConns).filter(p => socialConns[p]?.providerId);
    const hasMultipleLinks = linkedProviders.length > 1;

    if (!hasPassword && !hasMultipleLinks) {
      return res.status(400).json({
        message: "Please set a password before disconnecting your only social account",
        requiresPassword: true
      });
    }

    // Remove the provider
    delete user.socialConnections[provider];
    await user.save();

    // Return updated links
    const updatedLinks = Object.keys(user.socialConnections || {})
      .filter(p => user.socialConnections[p]?.providerId)
      .map(p => ({
        provider: p,
        username: user.socialConnections[p].username
      }));

    res.json({
      message: `${provider} has been disconnected`,
      socialLinks: updatedLinks
    });
  } catch (err) {
    console.error("Delete social-link error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// @route   GET /api/user/:id
// @desc    Get public profile for a user
// @access  Private
router.get("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "name avatar bio statusMessage banner bannerColor socialConnections createdAt reputation followers following"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Sanitize social links for public view
    const socialConns = user.socialConnections || {};
    const publicSocialLinks = Object.keys(socialConns)
      .filter(p => socialConns[p]?.providerId)
      .map(p => ({
        provider: p,
        username: socialConns[p].username
      }));

    res.json({
      _id: user._id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      statusMessage: user.statusMessage,
      banner: user.banner,
      bannerColor: user.bannerColor,
      socialLinks: publicSocialLinks,
      createdAt: user.createdAt,
      reputation: user.reputation,
      followersCount: user.followers?.length || 0,
      followingCount: user.following?.length || 0
    });
  } catch (err) {
    console.error("Get user profile error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
