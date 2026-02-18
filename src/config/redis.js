const { createClient } = require("redis");

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      // Don't keep retrying indefinitely if it fails 3 times in a row
      if (retries > 3) {
        if (retries === 4) console.warn("⚠️ Redis not available - continuing without it.");
        return false; // stop retrying
      }
      return Math.min(retries * 500, 2000);
    },
  },
});

let isRedisConnected = false;

redisClient.on("connect", () => {
  console.log("Redis Connecting...");
});

redisClient.on("ready", () => {
  isRedisConnected = true;
  console.log("✅ Redis Connected successfully");
});

redisClient.on("error", (err) => {
  // Only log if it's not a connection refused error after we've already warned
  if (err.code !== 'ECONNREFUSED' || !isRedisConnected) {
    // We'll keep this quiet in dev if it's just missing
  }
});

const connectRedis = async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    // Silence the initial connection error to avoid spam
    if (err.code === 'ECONNREFUSED') {
      console.log("ℹ️ Redis not found at", redisUrl, "- Features requiring Redis will be skipped.");
    } else {
      console.error("Redis Init Error:", err);
    }
  }
};

module.exports = { redisClient, connectRedis, getIsRedisConnected: () => isRedisConnected };
