const User = require("../models/User");

async function migrateReputation() {
  const result = await User.updateMany(
    { reputation: { $exists: false } },
    { $set: { reputation: 0 } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[migration] reputation: set to 0 on ${result.modifiedCount} user(s)`);
  }
}

module.exports = { migrateReputation };
