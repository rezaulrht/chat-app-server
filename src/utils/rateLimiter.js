const { redisClient, getIsRedisConnected } = require("../config/redis");

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 5; // 5 requests per minute per IP

const rateLimitMap = new Map();

/**
 * Check if request should be rate limited
 * @param {string} key - Rate limit key (usually IP address)
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} maxRequests - Maximum requests allowed in window
 * @returns {Promise<{limited: boolean, remaining: number, resetAt: number}>}
 */
async function checkRateLimit(key, windowMs = RATE_LIMIT_WINDOW, maxRequests = MAX_REQUESTS_PER_WINDOW) {
  const now = Date.now();
  const windowKey = `ratelimit:${key}`;
  
  let requestCount = 0;
  let resetAt = now + windowMs;
  
  if (getIsRedisConnected()) {
    try {
      // Use Redis for distributed rate limiting
      const stored = await redisClient.get(windowKey);
      if (stored) {
        try {
          const data = JSON.parse(stored);
          if (data && typeof data === 'object' && typeof data.count === 'number' && typeof data.resetAt === 'number' && data.resetAt > now) {
            requestCount = data.count;
            resetAt = data.resetAt;
          }
        } catch (parseErr) {
          // Malformed data - ignore stored value
        }
      }
      
      const newCount = requestCount + 1;
      const remaining = Math.max(0, maxRequests - newCount);
      const isLimited = newCount > maxRequests;
      
      if (!isLimited) {
        const chosenResetAt = resetAt ?? (now + windowMs);
        await redisClient.setEx(
          windowKey,
          Math.ceil((chosenResetAt - now) / 1000),
          JSON.stringify({ count: newCount, resetAt: chosenResetAt })
        );
      }
      
      return {
        limited: isLimited,
        remaining,
        resetAt
      };
    } catch (err) {
      console.error("Redis rate limit error:", err.message);
      // Fall through to memory fallback
    }
  }
  
  // Memory fallback for when Redis is unavailable
  const record = rateLimitMap.get(key);
  
  if (record && now < record.resetAt) {
    requestCount = record.count;
    resetAt = record.resetAt;
  }
  
  const newCount = requestCount + 1;
  const remaining = Math.max(0, maxRequests - newCount);
  const isLimited = newCount > maxRequests;
  
  if (!isLimited) {
    const existing = rateLimitMap.get(key);
    const resetAtValue = existing?.resetAt ?? (now + windowMs);
    rateLimitMap.set(key, {
      count: newCount,
      resetAt: resetAtValue
    });
  }
  
  return {
    limited: isLimited,
    remaining,
    resetAt
  };
}

/**
 * Middleware factory for rate limiting
 * @param {object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Maximum requests allowed
 * @param {function} options.keyGenerator - Function to generate rate limit key
 * @param {string} options.message - Error message when rate limited
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = RATE_LIMIT_WINDOW,
    maxRequests = MAX_REQUESTS_PER_WINDOW,
    keyGenerator = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
    message = "Too many requests, please try again later."
  } = options;
  
  return async (req, res, next) => {
    const key = typeof keyGenerator === 'function' ? keyGenerator(req) : keyGenerator;
    
    try {
      const result = await checkRateLimit(key, windowMs, maxRequests);
      
      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': result.remaining,
        'X-RateLimit-Reset': new Date(result.resetAt).toISOString()
      });
      
      if (result.limited) {
        return res.status(429).json({
          message,
          retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
        });
      }
      
      next();
    } catch (err) {
      // If rate limiting fails, allow the request through (fail open)
      console.error("Rate limiter error:", err.message);
      next();
    }
  };
}

// Cleanup old entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (now > value.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes
cleanupInterval.unref();

module.exports = {
  checkRateLimit,
  createRateLimiter,
  RATE_LIMIT_WINDOW,
  MAX_REQUESTS_PER_WINDOW
};
