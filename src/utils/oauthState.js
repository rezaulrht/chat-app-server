const { redisClient, getIsRedisConnected } = require("../config/redis");
const crypto = require("crypto");

const LINK_STATE_TTL = 15 * 60; // 15 minutes in seconds
const LINK_STATE_PREFIX = "oauth_link_state:";

/**
 * Generate a secure OAuth state token for account linking
 * @param {string} userId - The user's ID
 * @param {string} provider - The OAuth provider (google/github)
 * @returns {Promise<{state: string, authUrl: string}>}
 */
async function createOAuthLinkState(userId, provider) {
  const state = crypto.randomBytes(32).toString("hex");
  const stateData = {
    state,
    userId,
    provider,
    action: "link",
    createdAt: Date.now()
  };

  // Store in Redis with TTL if available, otherwise use memory fallback
  if (getIsRedisConnected()) {
    try {
      await redisClient.setEx(
        `${LINK_STATE_PREFIX}${state}`,
        LINK_STATE_TTL,
        JSON.stringify(stateData)
      );
    } catch (err) {
      console.error("Redis set error for OAuth state:", err.message);
      // Fall through to memory fallback
      memoryFallback.set(state, stateData);
    }
  } else {
    // Memory fallback with cleanup
    memoryFallback.set(state, stateData);
    cleanupMemoryFallback();
  }

  // Generate the OAuth URL
  const baseUrl = process.env.BASE_URL || "http://localhost:5000";
  const callbackUrl = `${baseUrl}/auth/${provider}/callback`;
  let authUrl;

  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const scopes = encodeURIComponent("openid email profile");
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&scope=${scopes}&state=${state}&access_type=offline&prompt=consent`;
  } else if (provider === "github") {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const scopes = encodeURIComponent("user:email");
    authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${scopes}&state=${state}`;
  }

  return { state, authUrl };
}

/**
 * Validate and retrieve OAuth link state
 * @param {string} state - The state token to validate
 * @returns {Promise<{valid: boolean, data?: object, error?: string}>}
 */
async function validateOAuthLinkState(state) {
  if (!state) {
    return { valid: false, error: "No state provided" };
  }

  let stateData = null;

  // Try Redis first
  if (getIsRedisConnected()) {
    try {
      const stored = await redisClient.GETDEL(`${LINK_STATE_PREFIX}${state}`);
      if (stored) {
        stateData = JSON.parse(stored);
      }
    } catch (err) {
      console.error("Redis GETDEL error for OAuth state:", err.message);
    }
  }

  // Fallback to memory if not in Redis
  if (!stateData) {
    stateData = memoryFallback.get(state);
    if (stateData) {
      memoryFallback.delete(state);
    }
  }

  if (!stateData) {
    return { valid: false, error: "Invalid or expired state" };
  }

  // Validate timestamp (reject if older than TTL)
  const age = Date.now() - stateData.createdAt;
  if (age > LINK_STATE_TTL * 1000) {
    return { valid: false, error: "State expired" };
  }

  // Validate it's a link action
  if (stateData.action !== "link") {
    return { valid: false, error: "Invalid action" };
  }

  return { valid: true, data: stateData };
}

/**
 * Delete an OAuth link state (for cleanup or cancellation)
 * @param {string} state - The state token to delete
 */
async function deleteOAuthLinkState(state) {
  if (getIsRedisConnected()) {
    try {
      await redisClient.del(`${LINK_STATE_PREFIX}${state}`);
    } catch (err) {
      console.error("Redis delete error for OAuth state:", err.message);
    }
  }
  memoryFallback.delete(state);
}

// Memory fallback for when Redis is unavailable
const memoryFallback = new Map();
let cleanupScheduled = false;

function cleanupMemoryFallback() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;

  // Clean up old entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    const maxAge = LINK_STATE_TTL * 1000;

    for (const [key, value] of memoryFallback.entries()) {
      if (now - value.createdAt > maxAge) {
        memoryFallback.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = {
  createOAuthLinkState,
  validateOAuthLinkState,
  deleteOAuthLinkState,
  LINK_STATE_TTL
};
