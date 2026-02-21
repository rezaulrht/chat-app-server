const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// @desc Register a new user
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({
      name,
      email,
      password: hashedPassword,
    });

    await user.save();

    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error(err.message);
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
