// chat-app-server/src/socket/wordspy.js
const mongoose = require("mongoose");
const WordSpyGame = require("../models/WordSpyGame");
const {
  verifyWorkspaceMember,
  findActiveGame,
  sanitizeGameState,
  isValidCategory,
  isValidDifficulty,
  countWords,
} = require("../middleware/WordSpy/wordspy.middleware");
const { generateWordPair, generateRevealText } = require("../controllers/WordSpy/wordspy.controller");

// ── Module-scoped state (persists across socket reconnections) ────────────────
// Key: gameId string → setTimeout handle
const phaseTimers = new Map();

// Key: "gameId:userId" → last accepted write timestamp (ms)
const hintRateLimits = new Map();
const voteRateLimits = new Map();

const PHASE_DURATIONS = {
  word_reveal: 8000,
  hint: 60000,
  vote: 45000,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const clearPhaseTimer = (gameId) => {
  const key = String(gameId);
  const timer = phaseTimers.get(key);
  if (timer) { clearTimeout(timer); phaseTimers.delete(key); }
};

const broadcastRoomUpdate = (io, game) => {
  io.to(`wordspy:${game._id}`).emit("wordspy:room:update", sanitizeGameState(game));
};

// ── Phase advancement ─────────────────────────────────────────────────────────

const advanceToHint = async (io, gameId) => {
  try {
    clearPhaseTimer(gameId);
    const game = await WordSpyGame.findById(gameId);
    if (!game || game.phase !== "word_reveal") return;

    const phaseEndsAt = new Date(Date.now() + PHASE_DURATIONS.hint);
    game.phase = "hint";
    game.phaseEndsAt = phaseEndsAt;
    await game.save();

    io.to(`wordspy:${gameId}`).emit("wordspy:phase:change", { phase: "hint", phaseEndsAt });
    broadcastRoomUpdate(io, game);

    const timer = setTimeout(() => lockHintsAndAdvance(io, gameId), PHASE_DURATIONS.hint);
    phaseTimers.set(String(gameId), timer);
  } catch (err) {
    console.error("advanceToHint error:", err.message);
  }
};

const lockHintsAndAdvance = async (io, gameId) => {
  try {
    clearPhaseTimer(gameId);
    const game = await WordSpyGame.findById(gameId);
    if (!game || game.phase !== "hint") return;

    // Fill missing hints for connected players
    for (const p of game.players) {
      if (p.isConnected && !p.hint) p.hint = "[no hint]";
    }
    await game.save();

    // Fire AI reveal in background — non-blocking, runs during vote phase
    fireRevealInBackground(io, game);

    // Advance to vote
    const phaseEndsAt = new Date(Date.now() + PHASE_DURATIONS.vote);
    game.phase = "vote";
    game.phaseEndsAt = phaseEndsAt;
    await game.save();

    const hints = game.players
      .filter((p) => p.hint)
      .map((p) => ({ userId: p.userId, displayName: p.displayName, hint: p.hint }));

    // IMPORTANT: hints:reveal fires BEFORE phase:change per spec
    io.to(`wordspy:${gameId}`).emit("wordspy:hints:reveal", { hints });
    io.to(`wordspy:${gameId}`).emit("wordspy:phase:change", { phase: "vote", phaseEndsAt });
    broadcastRoomUpdate(io, game);

    const timer = setTimeout(() => tallyVotesAndReveal(io, gameId), PHASE_DURATIONS.vote);
    phaseTimers.set(String(gameId), timer);
  } catch (err) {
    console.error("lockHintsAndAdvance error:", err.message);
  }
};

const fireRevealInBackground = async (io, game) => {
  // This runs during the vote phase (45s buffer). By the time reveal fires, aiReveal is ready.
  try {
    const impostorDoc = game.players.find((p) => p.userId.toString() === game.impostorId.toString());
    const hints = game.players.map((p) => ({
      displayName: p.displayName,
      hint: p.hint || "[no hint]",
    }));
    const aiReveal = await generateRevealText({
      category: game.category,
      realWord: game.realWord,
      impostorWord: game.impostorWord,
      impostorName: impostorDoc?.displayName || "Unknown",
      votedName: "TBD", // not known yet; tallyVotesAndReveal will re-call if needed
      correct: false,
      hints,
    });
    await WordSpyGame.findByIdAndUpdate(game._id, { aiReveal });
  } catch (err) {
    console.error("fireRevealInBackground error:", err.message);
    // Non-critical — tallyVotesAndReveal will use fallback text if aiReveal is null
  }
};

const tallyVotesAndReveal = async (io, gameId) => {
  try {
    clearPhaseTimer(gameId);
    const game = await WordSpyGame.findById(gameId);
    if (!game || game.phase !== "vote") return;

    // Tally votes from connected players
    const voteCounts = {};
    for (const p of game.players) {
      if (p.isConnected && p.vote) {
        const key = p.vote.toString();
        voteCounts[key] = (voteCounts[key] || 0) + 1;
      }
    }

    // Find max vote count and all players tied at that count
    const maxCount = Math.max(0, ...Object.values(voteCounts));
    const topVoted = Object.entries(voteCounts)
      .filter(([, count]) => count === maxCount)
      .map(([userId]) => userId);

    // Tiebreaker: random
    const votedId = topVoted.length > 0
      ? topVoted[Math.floor(Math.random() * topVoted.length)]
      : null;

    // correct = (votedId === impostorId) — purely identity-based
    const correct = votedId != null && votedId === game.impostorId.toString();

    // Update scores
    for (const p of game.players) {
      if (correct && p.isConnected && p.userId.toString() !== game.impostorId.toString()) {
        p.score += 2;
      } else if (!correct && p.userId.toString() === game.impostorId.toString()) {
        p.score += 3;
      }
    }

    game.phase = "reveal";
    game.phaseEndsAt = null;
    await game.save();

    // Use pre-computed aiReveal if available, otherwise generate now (fallback)
    let aiReveal = game.aiReveal;
    if (!aiReveal) {
      const votedDoc = game.players.find((p) => p.userId.toString() === (votedId || ""));
      const impostorDoc = game.players.find((p) => p.userId.toString() === game.impostorId.toString());
      aiReveal = await generateRevealText({
        category: game.category,
        realWord: game.realWord,
        impostorWord: game.impostorWord,
        impostorName: impostorDoc?.displayName || "Unknown",
        votedName: votedDoc?.displayName || "nobody",
        correct,
        hints: game.players.map((p) => ({ displayName: p.displayName, hint: p.hint || "[no hint]" })),
      });
      game.aiReveal = aiReveal;
      await game.save();
    }

    const impostorDoc = game.players.find((p) => p.userId.toString() === game.impostorId.toString());
    const scores = game.players.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      score: p.score,
    }));

    io.to(`wordspy:${gameId}`).emit("wordspy:phase:change", { phase: "reveal", phaseEndsAt: null });
    io.to(`wordspy:${gameId}`).emit("wordspy:reveal", {
      aiReveal,
      impostorId: game.impostorId,
      impostorName: impostorDoc?.displayName || "Unknown",
      realWord: game.realWord,
      impostorWord: game.impostorWord,
      votedId,
      correct,
      scores,
    });
    broadcastRoomUpdate(io, game);
  } catch (err) {
    console.error("tallyVotesAndReveal error:", err.message);
  }
};

const cancelRoundAndBackToLobby = async (io, game) => {
  clearPhaseTimer(game._id);
  game.phase = "lobby";
  game.realWord = null;
  game.impostorWord = null;
  game.impostorId = null;
  game.aiReveal = null;
  game.phaseEndsAt = null;
  for (const p of game.players) { p.hint = null; p.vote = null; }
  await game.save();
  io.to(`wordspy:${game._id}`).emit("wordspy:error", {
    message: "Round cancelled — not enough players connected",
  });
  io.to(`wordspy:${game._id}`).emit("wordspy:phase:change", { phase: "lobby", phaseEndsAt: null });
  broadcastRoomUpdate(io, game);
};

// ── Main handler factory ──────────────────────────────────────────────────────

const registerWordSpyHandlers = (socket, { io, emitToUser }) => {

  // ================================================================
  // wordspy:join
  // ================================================================
  socket.on("wordspy:join", async ({ moduleId, workspaceId } = {}) => {
    if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) return;
    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) return;

    try {
      // Verify workspace membership — use returned workspace, don't re-fetch
      const workspace = await verifyWorkspaceMember(socket.userId, workspaceId);
      if (!workspace) return socket.emit("wordspy:error", { message: "Access denied" });

      let game = await findActiveGame(moduleId);

      if (game && game.phase !== "lobby") {
        return socket.emit("wordspy:error", { message: "Game already in progress" });
      }

      const User = require("../models/User");
      const userDoc = await User.findById(socket.userId).select("name avatar");

      if (!game) {
        game = await WordSpyGame.create({
          workspaceId,
          moduleId,
          hostId: socket.userId,
          players: [{
            userId: socket.userId,
            displayName: userDoc?.name || "Player",
            avatar: userDoc?.avatar || "",
            isConnected: true,
          }],
        });
      } else {
        const alreadyIn = game.players.some((p) => p.userId.toString() === socket.userId);
        if (!alreadyIn) {
          if (game.players.length >= 8) {
            return socket.emit("wordspy:error", { message: "Game is full (max 8 players)" });
          }
          game.players.push({
            userId: socket.userId,
            displayName: userDoc?.name || "Player",
            avatar: userDoc?.avatar || "",
            isConnected: true,
          });
        } else {
          // Reconnect — mark as connected
          const p = game.players.find((pl) => pl.userId.toString() === socket.userId);
          if (p) p.isConnected = true;
          // Re-send private word if still in word_reveal phase
          if (game.phase === "word_reveal" && game.realWord) {
            const word = socket.userId === game.impostorId.toString()
              ? game.impostorWord
              : game.realWord;
            socket.emit("wordspy:word:private", { word });
          }
        }
        await game.save();
      }

      socket.join(`wordspy:${game._id}`);

      // Send current state to this socket specifically
      socket.emit("wordspy:room:update", sanitizeGameState(game));
      if (game.phaseEndsAt) {
        socket.emit("wordspy:phase:change", { phase: game.phase, phaseEndsAt: game.phaseEndsAt });
      }

      // Broadcast updated player list to everyone else
      broadcastRoomUpdate(io, game);
    } catch (err) {
      console.error("wordspy:join error:", err.message);
      socket.emit("wordspy:error", { message: "Failed to join game" });
    }
  });

  // ================================================================
  // wordspy:start — lobby → word_assign → word_reveal
  // ================================================================
  socket.on("wordspy:start", async ({ moduleId, category, difficulty, maxRounds } = {}) => {
    try {
      if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) {
        return socket.emit("wordspy:error", { message: "Invalid module" });
      }
      const game = await WordSpyGame.findOne({
        moduleId,
        hostId: socket.userId,
        phase: "lobby",
      });
      if (!game) return socket.emit("wordspy:error", { message: "No lobby found" });

      if (!isValidCategory(category)) {
        return socket.emit("wordspy:error", { message: "Invalid category (max 100 chars, letters/numbers/punctuation only)" });
      }
      if (!isValidDifficulty(difficulty)) {
        return socket.emit("wordspy:error", { message: "Difficulty must be easy, medium, or hard" });
      }

      const connectedCount = game.players.filter((p) => p.isConnected).length;
      if (connectedCount < 3) {
        return socket.emit("wordspy:error", { message: "Need at least 3 connected players to start" });
      }

      game.phase = "word_assign";
      game.category = category.trim();
      game.difficulty = difficulty;
      game.maxRounds = Math.min(Math.max(parseInt(maxRounds) || 3, 1), 10);
      await game.save();
      broadcastRoomUpdate(io, game);

      // Generate word pair (blocking — must resolve before word_reveal)
      let wordPair;
      try {
        wordPair = await generateWordPair(category.trim(), difficulty);
      } catch (err) {
        game.phase = "lobby";
        await game.save();
        broadcastRoomUpdate(io, game);
        return socket.emit("wordspy:error", {
          message: "Couldn't generate words for that category, try another.",
        });
      }

      // Pick random impostor from connected players
      const connected = game.players.filter((p) => p.isConnected);
      const impostor = connected[Math.floor(Math.random() * connected.length)];

      game.realWord = wordPair.realWord;
      game.impostorWord = wordPair.impostorWord;
      game.impostorId = impostor.userId;

      const phaseEndsAt = new Date(Date.now() + PHASE_DURATIONS.word_reveal);
      game.phase = "word_reveal";
      game.phaseEndsAt = phaseEndsAt;
      await game.save();

      // Send private words using emitToUser (targets all sockets for each userId)
      for (const player of game.players) {
        if (!player.isConnected) continue;
        const word = player.userId.toString() === impostor.userId.toString()
          ? game.impostorWord
          : game.realWord;
        await emitToUser(player.userId.toString(), "wordspy:word:private", { word });
      }

      io.to(`wordspy:${game._id}`).emit("wordspy:phase:change", { phase: "word_reveal", phaseEndsAt });
      broadcastRoomUpdate(io, game);

      clearPhaseTimer(game._id);
      const timer = setTimeout(() => advanceToHint(io, game._id), PHASE_DURATIONS.word_reveal);
      phaseTimers.set(String(game._id), timer);

    } catch (err) {
      console.error("wordspy:start error:", err.message);
      socket.emit("wordspy:error", { message: "Failed to start game" });
    }
  });

  // ================================================================
  // wordspy:hint:submit
  // ================================================================
  socket.on("wordspy:hint:submit", async ({ hint } = {}) => {
    try {
      const game = await WordSpyGame.findOne({
        "players.userId": socket.userId,
        phase: "hint",
      });
      if (!game) return;

      if (!hint || typeof hint !== "string") return;
      const wordCount = countWords(hint);
      if (wordCount < 4 || wordCount > 20) {
        return socket.emit("wordspy:error", { message: "Hint must be 4–20 words" });
      }

      // Rate limit: 1 accepted write per 2s per player per game
      const rlKey = `${game._id}:${socket.userId}`;
      const lastWrite = hintRateLimits.get(rlKey) || 0;
      if (Date.now() - lastWrite < 2000) return;
      hintRateLimits.set(rlKey, Date.now());

      const player = game.players.find((p) => p.userId.toString() === socket.userId);
      if (!player || !player.isConnected) return;

      player.hint = hint.trim();
      await game.save();

      // Broadcast hint submission progress (separate event from vote progress)
      const connected = game.players.filter((p) => p.isConnected);
      const submitted = connected.filter((p) => p.hint).length;
      io.to(`wordspy:${game._id}`).emit("wordspy:hint:progress", {
        submitted,
        total: connected.length,
      });

      // Early advance if all connected players submitted
      if (connected.every((p) => p.hint)) {
        lockHintsAndAdvance(io, game._id);
      }
    } catch (err) {
      console.error("wordspy:hint:submit error:", err.message);
    }
  });

  // ================================================================
  // wordspy:vote:submit
  // ================================================================
  socket.on("wordspy:vote:submit", async ({ targetUserId } = {}) => {
    try {
      if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) return;

      const game = await WordSpyGame.findOne({
        "players.userId": socket.userId,
        phase: "vote",
      });
      if (!game) return;

      if (targetUserId === socket.userId) {
        return socket.emit("wordspy:error", { message: "You cannot vote for yourself" });
      }

      // Rate limit
      const rlKey = `${game._id}:${socket.userId}`;
      const lastWrite = voteRateLimits.get(rlKey) || 0;
      if (Date.now() - lastWrite < 2000) return;
      voteRateLimits.set(rlKey, Date.now());

      const player = game.players.find((p) => p.userId.toString() === socket.userId);
      if (!player || !player.isConnected) return;

      player.vote = targetUserId;
      await game.save();

      const connected = game.players.filter((p) => p.isConnected);
      const votedCount = connected.filter((p) => p.vote).length;
      io.to(`wordspy:${game._id}`).emit("wordspy:vote:progress", {
        submitted: votedCount,
        total: connected.length,
      });

      // Early advance if all connected players voted
      if (connected.every((p) => p.vote)) {
        tallyVotesAndReveal(io, game._id);
      }
    } catch (err) {
      console.error("wordspy:vote:submit error:", err.message);
    }
  });

  // ================================================================
  // wordspy:next:round — host only, reveal phase only
  // ================================================================
  socket.on("wordspy:next:round", async () => {
    try {
      const game = await WordSpyGame.findOne({ hostId: socket.userId, phase: "reveal" });
      if (!game) return socket.emit("wordspy:error", { message: "Not authorized or wrong phase" });

      if (game.round >= game.maxRounds) {
        game.phase = "results";
        game.phaseEndsAt = null;
        await game.save();
        io.to(`wordspy:${game._id}`).emit("wordspy:phase:change", { phase: "results", phaseEndsAt: null });
        broadcastRoomUpdate(io, game);
        return;
      }

      game.round += 1;
      game.phase = "lobby";
      game.realWord = null;
      game.impostorWord = null;
      game.impostorId = null;
      game.aiReveal = null;
      game.phaseEndsAt = null;
      for (const p of game.players) { p.hint = null; p.vote = null; }
      await game.save();

      io.to(`wordspy:${game._id}`).emit("wordspy:phase:change", { phase: "lobby", phaseEndsAt: null });
      broadcastRoomUpdate(io, game);
    } catch (err) {
      console.error("wordspy:next:round error:", err.message);
    }
  });

  // ================================================================
  // wordspy:disband — host only, lobby or results phase only
  // ================================================================
  socket.on("wordspy:disband", async () => {
    try {
      const game = await WordSpyGame.findOne({
        hostId: socket.userId,
        phase: { $in: ["lobby", "results"] },
      });
      if (!game) return socket.emit("wordspy:error", { message: "Not authorized or wrong phase" });

      clearPhaseTimer(game._id);
      const roomKey = `wordspy:${game._id}`;
      io.to(roomKey).emit("wordspy:disbanded", { message: "The host has disbanded the room." });
      await WordSpyGame.findByIdAndDelete(game._id);
    } catch (err) {
      console.error("wordspy:disband error:", err.message);
    }
  });

  // ================================================================
  // wordspy:leave — non-host player leaves current game
  // ================================================================
  socket.on("wordspy:leave", async () => {
    try {
      const game = await WordSpyGame.findOne({
        "players.userId": socket.userId,
        phase: { $nin: ["results"] },
      });
      if (!game) return;

      if (String(game.hostId) === String(socket.userId)) {
        return socket.emit("wordspy:error", {
          message: "Host cannot leave. Disband the room instead.",
        });
      }

      const beforeCount = game.players.length;
      game.players = game.players.filter(
        (p) => p.userId.toString() !== String(socket.userId),
      );

      if (game.players.length === beforeCount) return;

      // Best-effort cleanup of per-player rate-limit buckets for this game.
      hintRateLimits.delete(`${game._id}:${socket.userId}`);
      voteRateLimits.delete(`${game._id}:${socket.userId}`);

      await game.save();

      socket.leave(`wordspy:${game._id}`);
      socket.emit("wordspy:left", { message: "You left the game." });

      // If no players remain, end the room entirely.
      if (game.players.length === 0) {
        clearPhaseTimer(game._id);
        await WordSpyGame.findByIdAndDelete(game._id);
        return;
      }

      const connectedCount = game.players.filter((p) => p.isConnected).length;
      if (
        connectedCount < 3 &&
        !["lobby", "reveal", "results"].includes(game.phase)
      ) {
        await cancelRoundAndBackToLobby(io, game);
        return;
      }

      // Check early-advance conditions after a player leaves.
      if (game.phase === "hint") {
        const connected = game.players.filter((p) => p.isConnected);
        if (connected.length > 0 && connected.every((p) => p.hint)) {
          lockHintsAndAdvance(io, game._id);
          return;
        }
      }
      if (game.phase === "vote") {
        const connected = game.players.filter((p) => p.isConnected);
        if (connected.length > 0 && connected.every((p) => p.vote)) {
          tallyVotesAndReveal(io, game._id);
          return;
        }
      }

      broadcastRoomUpdate(io, game);
    } catch (err) {
      console.error("wordspy:leave error:", err.message);
      socket.emit("wordspy:error", { message: "Failed to leave game" });
    }
  });

  // ================================================================
  // wordspy:end:game — host only, reveal phase only
  // ================================================================
  socket.on("wordspy:end:game", async () => {
    try {
      const game = await WordSpyGame.findOne({ hostId: socket.userId, phase: "reveal" });
      if (!game) return socket.emit("wordspy:error", { message: "Not authorized or wrong phase" });

      clearPhaseTimer(game._id);
      game.phase = "results";
      game.phaseEndsAt = null;
      await game.save();

      io.to(`wordspy:${game._id}`).emit("wordspy:phase:change", { phase: "results", phaseEndsAt: null });
      broadcastRoomUpdate(io, game);
    } catch (err) {
      console.error("wordspy:end:game error:", err.message);
    }
  });

  // ================================================================
  // Disconnect handler — called from handler.js on socket disconnect
  // ================================================================
  const handleDisconnect = async () => {
    try {
      const game = await WordSpyGame.findOne({
        "players.userId": socket.userId,
        phase: { $nin: ["results"] },
      });
      if (!game) return;

      const player = game.players.find((p) => p.userId.toString() === socket.userId);
      if (!player) return;

      player.isConnected = false;
      await game.save();

      // All disconnected → mark complete immediately
      if (game.players.every((p) => !p.isConnected)) {
        clearPhaseTimer(game._id);
        game.phase = "results";
        await game.save();
        return;
      }

      // Connected drops below 3 in active round → cancel
      const connectedCount = game.players.filter((p) => p.isConnected).length;
      if (connectedCount < 3 && !["lobby", "reveal", "results"].includes(game.phase)) {
        await cancelRoundAndBackToLobby(io, game);
        return;
      }

      // Host migration
      if (game.hostId.toString() === socket.userId) {
        const newHost = game.players.find((p) => p.isConnected);
        if (newHost) { game.hostId = newHost.userId; await game.save(); }
      }

      // Check early-advance conditions after disconnect
      if (game.phase === "hint") {
        const connected = game.players.filter((p) => p.isConnected);
        if (connected.every((p) => p.hint)) lockHintsAndAdvance(io, game._id);
      }
      if (game.phase === "vote") {
        const connected = game.players.filter((p) => p.isConnected);
        if (connected.every((p) => p.vote)) tallyVotesAndReveal(io, game._id);
      }

      broadcastRoomUpdate(io, game);
    } catch (err) {
      console.error("wordspy disconnect error:", err.message);
    }
  };

  // Single return — handleDisconnect only (phaseTimers is module-scoped)
  return { handleDisconnect };
};

module.exports = registerWordSpyHandlers;
