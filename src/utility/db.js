const mongoose = require("mongoose");
require("dotenv").config();
const dns = require("dns");

// Use Google DNS to resolve MongoDB Atlas SRV records reliably
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const connectDB = async () => {
  try {
    const mongoURI =
      process.env.MONGODB_URI || "mongodb://localhost:27017/convox-chatapp";

    await mongoose.connect(mongoURI);

    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
