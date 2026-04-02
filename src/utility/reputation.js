const User = require("../models/User");

/**
 * Award or deduct reputation points from a user.
 *
 * Null-safe: works even when the `reputation` field is absent from the document.
 * Floor: reputation never drops below 0.
 *
 * @param {string|import("mongoose").Types.ObjectId} userId
 * @param {number} delta — positive to add, negative to subtract
 * @param {{ session?: import("mongoose").ClientSession }} [options]
 */
async function awardReputation(userId, delta, { session } = {}) {
  if (!userId) return;
  if (typeof delta !== "number" || delta === 0) return;

  const opts = session ? { session } : {};

  if (delta > 0) {
    // $inc treats missing/null field as 0 — always safe
    await User.findByIdAndUpdate(userId, { $inc: { reputation: delta } }, opts);
  } else {
    // Aggregation pipeline needed for the $max floor
    // $ifNull guards against missing field on old documents
    await User.findByIdAndUpdate(userId, [
      {
        $set: {
          reputation: {
            $max: [
              0,
              { $add: [{ $ifNull: ["$reputation", 0] }, delta] },
            ],
          },
        },
      },
    ], opts);
  }
}

module.exports = { awardReputation };
