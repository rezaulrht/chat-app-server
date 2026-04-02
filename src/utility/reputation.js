const User = require("../models/User");

/**
 * Award or deduct reputation points from a user.
 *
 * Null-safe: works even when the `reputation` field is absent from the document.
 * Floor: reputation never drops below 0.
 *
 * @param {string|import("mongoose").Types.ObjectId} userId
 * @param {number} delta — positive to add, negative to subtract
 */
async function awardReputation(userId, delta) {
  if (!userId) return;
  if (typeof delta !== "number" || delta === 0) return;

  if (delta > 0) {
    // $inc treats missing/null field as 0 — always safe
    await User.findByIdAndUpdate(userId, { $inc: { reputation: delta } });
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
    ]);
  }
}

module.exports = { awardReputation };
