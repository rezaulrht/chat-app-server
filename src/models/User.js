const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function () {
        return this.provider === "local";
      },
    },
    avatar: {
      type: String,
      default: "",
    },
    provider: {
      type: String,
      enum: ["local", "google", "github"],
      default: "local",
    },
    providerId: {
      type: String,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },

    // Account Locking Fields
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },

    // Profile extras
    bio: {
      type: String,
      maxlength: 500,
      default: "",
    },
    displayName: {
      type: String,
      default: null,
    },
    statusMessage: {
      type: String,
      maxlength: 80,
      default: "",
    },

    // ── Banner management ────────────────────────────────────────────
    banner: {
      imageUrl: {
        type: String,
        default: null,
      },
      cropData: {
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
      },
    },
    bannerColor: {
      type: String,
      default: null,
    },

    // ── Social Connections ──────────────────────────────────────────
    socialConnections: {
      github: {
        providerId: String,
        username: String,
        url: String,
        connectedAt: Date,
      },
      google: {
        providerId: String,
        username: String,
        url: String,
        connectedAt: Date,
      },
    },

    // resetToken
    resetToken: String,
    resetTokenExpiry: Date,

    // ── Feed / Social fields ─────────────────────────────────────────
    reputation: {
      type: Number,
      min: 0,
      default: 0,
    },

    following: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    followers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    followedTags: [
      {
        type: String,
        trim: true,
        lowercase: true,
        maxlength: 40,
      },
    ],

    // ── Notification preferences ─────────────────────────────────────────────
    notificationPrefs: {
      chat_message: { type: Boolean, default: true },
      chat_mention: { type: Boolean, default: true },
      call_missed: { type: Boolean, default: true },
      feed_reaction: { type: Boolean, default: true },
      feed_comment: { type: Boolean, default: true },
      feed_follow: { type: Boolean, default: true },
      workspace_mention: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
userSchema.index({ reputation: -1 }); // leaderboard sort
userSchema.index({ followedTags: 1 });
userSchema.index({ followers: 1 });

module.exports = mongoose.model("User", userSchema);
