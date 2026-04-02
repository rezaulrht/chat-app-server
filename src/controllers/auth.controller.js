const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendOTP } = require("../utility/email");
const { redisClient } = require("../config/redis");
const axios = require("axios");
const FormData = require("form-data");

// @desc Register a new user
exports.register = async (req, res) => {
  try {
    const { name, email, password, avatar } = req.body;

    let user = await User.findOne({ email });
    if (user) {
      if (!user.isVerified) {
        return res
          .status(400)
          .json({
            message:
              "Account exists but is not verified. Please login to verify.",
          });
      }
      return res.status(400).json({ message: "User already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let finalAvatar = avatar;

    // Generate fallback avatar if none provided, but fetch it and upload to ImgBB
    if (!finalAvatar) {
      try {
        const initialsUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&size=128&length=1&rounded=true&bold=true`;

        // 1. Fetch the image buffer from ui-avatars
        const imageResponse = await axios.get(initialsUrl, {
          responseType: "arraybuffer",
        });
        const imageBuffer = Buffer.from(imageResponse.data, "binary");

        // 2. Prepare FormData for ImgBB
        const formData = new FormData();
        const safeName =
          name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "user";
        const safeEmailPrefix = email
          .split("@")[0]
          .replace(/[^a-zA-Z0-9]/g, "")
          .toLowerCase();
        const uniqueFilename = `${safeName}_${safeEmailPrefix}_avatar.png`;

        formData.append("image", imageBuffer, {
          filename: uniqueFilename,
          contentType: "image/png",
        });

        // 3. Upload to ImgBB securely from backend
        const imgbbKey = process.env.IMGBB_API_KEY;
        if (!imgbbKey) {
          console.warn(
            "IMGBB_API_KEY is missing in backend .env. Defaulting to raw ui-avatars url.",
          );
          finalAvatar = initialsUrl;
        } else {
          const imgbbResponse = await axios.post(
            `https://api.imgbb.com/1/upload?key=${imgbbKey}`,
            formData,
            {
              headers: formData.getHeaders(),
            },
          );

          if (imgbbResponse.data && imgbbResponse.data.success) {
            finalAvatar = imgbbResponse.data.data.display_url;
          } else {
            finalAvatar = initialsUrl; // fallback if ImgBB fails
          }
        }
      } catch (avatarErr) {
        console.error(
          "Error generating/uploading fallback avatar:",
          avatarErr.message,
        );
        // Absolute fallback empty or default
        finalAvatar = "";
      }
    }

    user = new User({
      name,
      email,
      password: hashedPassword,
      avatar: finalAvatar,
      isVerified: false,
    });

    await user.save();

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store securely in Redis for 10 minutes (600 seconds)
    if (redisClient && redisClient.isReady) {
      await redisClient.set(`otp:${email.toLowerCase()}`, otp, { EX: 600 });
    } else {
      console.error("Redis is not ready! OTP cannot be saved.");
      return res.status(500).json({ message: "Internal server error" });
    }

    // Send the email
    await sendOTP(email, name, otp);

    res.status(201).json({ message: "Verification OTP sent to your email" });
  } catch (err) {
    console.error("Register Error:", err.message);
    res.status(500).send("Server error");
  }
};

// Helper function to generate token
const generateToken = (user) => {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// @desc Authenticate user & get token
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const MAX_ATTEMPTS = 5;
    const LOCK_TIME = 15 * 60 * 1000; // 15 minutes

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    //  Check if account is locked
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const remainingTime = Math.ceil((user.lockUntil - Date.now()) / 60000);

      return res.status(403).json({
        message: `Account locked. Try again in ${remainingTime} minute(s).`,
      });
    }

    // Block unverified users from logging in outright
    if (!user.isVerified) {
      // Proactively send a new OTP if they try to login while unverified
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      if (redisClient && redisClient.isReady) {
        await redisClient.set(`otp:${email.toLowerCase()}`, otp, { EX: 600 });
        // Send email (don't await to keep login response snappy, or await if you want to ensure delivery before reporting)
        await sendOTP(user.email, user.name, otp);
      }

      return res.status(403).json({
        message: "Account not verified",
        code: "UNVERIFIED_ACCOUNT",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    //  Wrong password
    if (!isMatch) {
      user.failedLoginAttempts += 1;

      if (user.failedLoginAttempts >= MAX_ATTEMPTS) {
        user.lockUntil = Date.now() + LOCK_TIME;
        user.failedLoginAttempts = 0;
        await user.save();

        return res.status(403).json({
          message:
            "Account locked for 15 minutes due to multiple failed attempts.",
        });
      }

      await user.save();

      const remainingAttempts = MAX_ATTEMPTS - user.failedLoginAttempts;

      return res.status(400).json({
        message: `Invalid credentials. ${remainingAttempts} attempt(s) remaining.`,
      });
    }

    // Successful login → reset counters
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
      },
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
};

// @desc OAuth Callback
exports.oauthCallback = async (req, res) => {
  try {
    // Check if this is a social account linking flow
    const state = req.query.state;
    let isLinking = false;
    let linkUserId = null;
    
    if (state && global.linkStates) {
      const stateData = global.linkStates.get(state);
      if (stateData && stateData.action === "link") {
        isLinking = true;
        linkUserId = stateData.userId;
        // Clean up the used state
        global.linkStates.delete(state);
      }
    }
    
    // Handle account linking flow
    if (isLinking && linkUserId) {
      const User = require("../models/User");
      const user = await User.findById(linkUserId);
      
      if (!user) {
        return res.redirect(`${process.env.SITE_URL}/login-error?message=User not found`);
      }
      
      // Get provider info from passport
      const provider = req.user.provider || (req.user.google?.providerId ? "google" : "github");
      const providerId = req.user.providerId || 
        (req.user.google?.providerId) || 
        (req.user.github?.providerId) ||
        req.user.id;
      const providerUsername = req.user.displayName || req.user.username || "";
      
      // Link the social account to the existing user
      if (!user.socialConnections) user.socialConnections = {};
      user.socialConnections[provider] = {
        providerId: providerId,
        username: providerUsername,
        url: provider === "google" 
          ? `https://accounts.google.com/${providerId}`
          : `https://github.com/${providerUsername}`,
        connectedAt: new Date()
      };
      
      await user.save();
      
      // Generate token for the existing user and redirect to profile
      const token = generateToken(user);
      return res.redirect(`${process.env.SITE_URL}/login-success?token=${token}&linked=${provider}&linked=true`);
    }
    
    // Normal login flow
    const token = generateToken(req.user);
    
    // Build redirect URL with optional merge info
    let redirectUrl = `${process.env.SITE_URL}/login-success?token=${token}`;
    
    // Surface merge info to client if user just merged accounts
    if (req.user.justMerged) {
      redirectUrl += `&merged=true`;
      if (req.user.mergeMessage) {
        redirectUrl += `&mergeMessage=${encodeURIComponent(req.user.mergeMessage)}`;
      }
    }
    
    // Clear ephemeral properties after use
    delete req.user.justMerged;
    delete req.user.mergeMessage;
    
    res.redirect(redirectUrl);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
};

// @desc Get current user
exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
};

// @desc Update current user's profile (name, bio, statusMessage, avatar)
exports.updateMe = async (req, res) => {
  try {
    const { name, bio, statusMessage, avatar } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 50)
        return res
          .status(400)
          .json({ message: "Name must be 1–50 characters" });
      user.name = trimmed;
    }

    if (bio !== undefined) {
      if (bio.length > 500)
        return res
          .status(400)
          .json({ message: "Bio must be 500 characters or fewer" });
      user.bio = bio.trim();
    }

    if (statusMessage !== undefined) {
      if (statusMessage.length > 80)
        return res
          .status(400)
          .json({ message: "Status must be 80 characters or fewer" });
      user.statusMessage = statusMessage.trim();
    }

    if (avatar !== undefined && avatar !== user.avatar) {
      // Accept data URIs (base64) — upload to ImgBB from the server
      if (avatar.startsWith("data:")) {
        const imgbbKey = process.env.IMGBB_API_KEY;
        if (!imgbbKey) {
          return res
            .status(500)
            .json({ message: "Image upload not configured" });
        }
        try {
          const base64Data = avatar.split(",")[1];
          const formData = new FormData();
          formData.append("image", base64Data);
          const imgbbRes = await axios.post(
            `https://api.imgbb.com/1/upload?key=${imgbbKey}`,
            formData,
            { headers: formData.getHeaders() },
          );
          if (imgbbRes.data?.success) {
            user.avatar = imgbbRes.data.data.display_url;
          } else {
            return res.status(500).json({ message: "Image upload failed" });
          }
        } catch (uploadErr) {
          console.error("ImgBB upload error:", uploadErr.message);
          return res.status(500).json({ message: "Image upload failed" });
        }
      } else {
        // Plain URL — store directly
        user.avatar = avatar;
      }
    }

    await user.save();

    const { password: _pw, ...safeUser } = user.toObject();
    res.json(safeUser);
  } catch (err) {
    console.error("updateMe error:", err.message);
    res.status(500).send("Server error");
  }
};

// @desc Change password (local accounts only)
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both passwords are required" });

    if (newPassword.length < 8)
      return res
        .status(400)
        .json({ message: "New password must be at least 8 characters" });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.provider !== "local")
      return res
        .status(400)
        .json({
          message: "Password change is not available for OAuth accounts",
        });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Current password is incorrect" });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("changePassword error:", err.message);
    res.status(500).send("Server error");
  }
};

// @desc Verify OTP
exports.verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "User is already verified" });
    }

    // Check Redis for the expected OTP
    const expectedOTP = await redisClient.get(`otp:${email.toLowerCase()}`);
    if (!expectedOTP) {
      return res.status(400).json({ message: "OTP expired or does not exist" });
    }

    if (expectedOTP !== otp.toString()) {
      return res.status(400).json({ message: "Invalid OTP code" });
    }

    // Mark user as verified
    user.isVerified = true;
    await user.save();

    // Clean up Redis
    await redisClient.del(`otp:${email.toLowerCase()}`);

    // Log the user in
    const token = generateToken(user);
    res.json({
      message: "Email verified successfully",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
      },
    });
  } catch (err) {
    console.error("verifyOTP Error:", err.message);
    res.status(500).send("Server error");
  }
};

// @desc Resend OTP
exports.resendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "User is already verified" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    if (redisClient && redisClient.isReady) {
      await redisClient.set(`otp:${email.toLowerCase()}`, otp, { EX: 600 });
    } else {
      return res.status(500).json({ message: "Internal server error" });
    }

    await sendOTP(user.email, user.name, otp);

    res.status(200).json({ message: "New OTP sent to your email" });
  } catch (err) {
    console.error("resendOTP Error:", err.message);
    res.status(500).send("Server error");
  }
};

// @desc Upload banner with crop data
// @route PATCH /api/auth/me/banner
// @body { image: File, cropData: { x, y, width, height } }
exports.uploadBanner = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if image file is provided
    if (!req.file) {
      return res.status(400).json({ message: "No image provided" });
    }

    // Note: Size and MIME type validation is handled by multer middleware

    // Upload to ImgBB
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!imgbbKey) {
      return res.status(500).json({ message: "Image upload service not configured" });
    }

    const formData = new FormData();
    formData.append("image", req.file.buffer, {
      filename: `banner_${userId}_${Date.now()}.${req.file.mimetype.split('/')[1]}`,
      contentType: req.file.mimetype,
    });

    let imgbbResponse;
    try {
      imgbbResponse = await axios.post(
        `https://api.imgbb.com/1/upload?key=${imgbbKey}`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 15000, // 15 second timeout for image upload
        }
      );
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return res.status(504).json({ message: "Image upload timed out. Please try again." });
      }
      throw err;
    }

    if (!imgbbResponse.data || !imgbbResponse.data.success) {
      return res.status(500).json({ message: "Failed to upload image to storage" });
    }

    const bannerUrl = imgbbResponse.data.data.display_url;

    // Parse crop data
    let cropData = { x: 0, y: 0, width: 0, height: 0 };
    if (req.body.cropData) {
      try {
        const parsed = typeof req.body.cropData === 'string'
          ? JSON.parse(req.body.cropData)
          : req.body.cropData;
        cropData = {
          x: parsed.x || 0,
          y: parsed.y || 0,
          width: parsed.width || 0,
          height: parsed.height || 0,
        };
      } catch (e) {
        console.warn("Failed to parse cropData, using defaults");
      }
    }

    // Update user banner
    user.banner = {
      imageUrl: bannerUrl,
      cropData,
    };

    await user.save();

    res.json({
      message: "Banner uploaded successfully",
      banner: user.banner,
    });
  } catch (err) {
    console.error("uploadBanner Error:", err.message);
    res.status(500).json({ message: "Server error uploading banner" });
  }
};

// @desc Connect GitHub account
// @route POST /api/auth/me/connect/github
// @body { code: string } (from GitHub OAuth flow)
exports.connectGitHub = async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: "GitHub authorization code required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Exchange authorization code for access token (with timeout)
    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
        },
        {
          headers: { Accept: "application/json" },
          timeout: 10000, // 10 second timeout
        }
      );
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return res.status(504).json({ message: "GitHub authentication timed out. Please try again." });
      }
      throw err;
    }

    if (!tokenResponse.data || !tokenResponse.data.access_token) {
      return res.status(400).json({ message: "Failed to obtain GitHub access token" });
    }

    const accessToken = tokenResponse.data.access_token;

    // Fetch GitHub user profile (with timeout)
    let profileResponse;
    try {
      profileResponse = await axios.get("https://api.github.com/user", {
        headers: {
          Authorization: `token ${accessToken}`,
          "User-Agent": "ConvoX-Server",
        },
        timeout: 10000, // 10 second timeout
      });
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return res.status(504).json({ message: "GitHub API timed out. Please try again." });
      }
      throw err;
    }

    const githubProfile = profileResponse.data;
    const providerId = String(githubProfile.id);
    const username = githubProfile.login;

    // Check if this GitHub account is already linked to ANOTHER user
    const existingOwner = await User.findOne({
      _id: { $ne: userId }, // Different user
      "socialConnections.github.providerId": providerId
    });

    if (existingOwner) {
      return res.status(409).json({ 
        message: "This GitHub account is already linked to another user"
      });
    }

    // Update user's social connections
    user.socialConnections = user.socialConnections || {};
    user.socialConnections.github = {
      providerId,
      username,
      url: githubProfile.html_url || `https://github.com/${username}`,
      connectedAt: new Date(),
    };

    await user.save();

    res.json({
      message: "GitHub connected successfully",
      user: {
        _id: user._id,
        socialConnections: user.socialConnections,
      },
    });
  } catch (err) {
    console.error("connectGitHub Error:", err.response?.data || err.message);
    if (err.response?.status === 401) {
      return res.status(400).json({ message: "Invalid or expired authorization code" });
    }
    res.status(500).json({ message: "Server error connecting GitHub" });
  }
};

// @desc Disconnect social provider
// @route DELETE /api/auth/me/connect/:provider
exports.disconnectProvider = async (req, res) => {
  try {
    const userId = req.user.id;
    const { provider } = req.params;

    // Validate provider
    if (!['github', 'google'].includes(provider)) {
      return res.status(400).json({ message: "Invalid provider" });
    }

    // Use accountMerge service for consistent logic
    const { disconnectProvider: disconnect } = require("../services/accountMerge.service");
    const user = await disconnect(userId, provider);

    res.json({
      message: `${provider} disconnected successfully`,
      user: {
        _id: user._id,
        socialConnections: user.socialConnections,
      },
    });
  } catch (err) {
    console.error("disconnectProvider Error:", err.message);
    if (err.message.includes("Cannot disconnect")) {
      return res.status(400).json({ message: err.message });
    }
    if (err.message === "User not found") {
      return res.status(404).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};
