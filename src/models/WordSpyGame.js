const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  displayName: { type: String, required: true },
  avatar: { type: String, default: "" },
  score: { type: Number, default: 0 },
  isConnected: { type: Boolean, default: true },
  hint: { type: String, default: null },
  vote: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
});

const wordSpyGameSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    moduleId: { type: mongoose.Schema.Types.ObjectId, ref: "Module", required: true },
    phase: {
      type: String,
      enum: ["lobby", "word_assign", "word_reveal", "hint", "vote", "reveal", "results"],
      default: "lobby",
    },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    players: [playerSchema],
    category: { type: String, default: null, maxlength: 100 },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    realWord: { type: String, default: null },
    impostorWord: { type: String, default: null },
    impostorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    phaseEndsAt: { type: Date, default: null },
    aiReveal: { type: String, default: null },
    round: { type: Number, default: 1 },
    maxRounds: { type: Number, default: 3 },
  },
  { timestamps: true }
);

// Index for fast lookup by moduleId (one active game per module)
wordSpyGameSchema.index({ moduleId: 1, phase: 1 });

module.exports = mongoose.model("WordSpyGame", wordSpyGameSchema);
