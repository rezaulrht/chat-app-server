const { createClient } = require("redis");

const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        return new Error("Too many retries");
      }
      return Math.min(retries * 100, 3000);
    },
  },
});

redisClient.on("connect", () => {
  console.log("Redis Connecting...");
});

redisClient.on("ready", () => {
  console.log("Redis Connected successfully");
});

redisClient.on("error", (err) => {
  console.error("Redis Error:", err);
});

const connectRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  } catch (err) {
    console.error("Redis connection failed", err);
  }
};

module.exports = { redisClient, connectRedis };
