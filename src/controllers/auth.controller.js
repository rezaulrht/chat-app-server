const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendOTP } = require("../utility/email");
const { redisClient } = require("../config/redis");

// @desc Register a new user
exports.register = async (req, res) => {
  try {
    const { name, email, password, avatar } = req.body;

    let user = await User.findOne({ email });
    if (user) {
      if (!user.isVerified) {
        return res.status(400).json({ message: "Account exists but is not verified. Please login to verify." });
      }
      return res.status(400).json({ message: "User already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate fallback avatar if none provided (ui-avatars params: random background, 128px size, calculated length, rounded, bold)
    const initialsLength = name.trim().split(/\s+/).length > 1 ? 2 : 1;
    const finalAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&size=128&length=${initialsLength}&rounded=true&bold=true`;

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
    const token = generateToken(req.user);
    res.redirect(`${process.env.SITE_URL}/login-success?token=${token}`);
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
