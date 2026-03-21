const Workspace = require("../../models/Workspace");
const WordSpyGame = require("../../models/WordSpyGame");

/**
 * Verify socket.userId is a member of the given workspace.
 * Returns the workspace doc or null.
 */
const verifyWorkspaceMember = async (userId, workspaceId) => {
  return Workspace.findOne({
    _id: workspaceId,
    "members.user": userId,
  }).select("_id members");
};

/**
 * Find the active (non-completed) game for a module.
 */
const findActiveGame = async (moduleId) => {
  return WordSpyGame.findOne({
    moduleId,
    phase: { $nin: ["results"] },
  });
};

/**
 * Build the sanitized room:update payload — strips all secret fields.
 * NEVER includes: realWord, impostorWord, impostorId, hint, vote
 */
const sanitizeGameState = (game) => ({
  _id: game._id,
  phase: game.phase,
  phaseEndsAt: game.phaseEndsAt,
  round: game.round,
  maxRounds: game.maxRounds,
  hostId: game.hostId,
  category: game.category,
  players: game.players.map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    avatar: p.avatar,
    score: p.score,
    isConnected: p.isConnected,
  })),
});

/**
 * Validate category input: max 100 chars, alphanumeric + spaces + common punctuation.
 */
const isValidCategory = (category) => {
  if (!category || typeof category !== "string") return false;
  if (category.trim().length === 0 || category.length > 100) return false;
  return /^[a-zA-Z0-9\s.,!?'"-]+$/.test(category);
};

/**
 * Validate difficulty is one of the accepted enum values.
 */
const isValidDifficulty = (difficulty) => {
  return ["easy", "medium", "hard"].includes(difficulty);
};

/**
 * Count words in a hint string.
 */
const countWords = (str) => str.trim().split(/\s+/).filter(Boolean).length;

module.exports = {
  verifyWorkspaceMember,
  findActiveGame,
  sanitizeGameState,
  isValidCategory,
  isValidDifficulty,
  countWords,
};
