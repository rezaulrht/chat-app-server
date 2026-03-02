require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const connectDB = require("./src/utility/db");
const socketHandler = require("./src/socket/handler");
const authRoutes = require("./src/routes/auth.routes");
const chatRoutes = require("./src/routes/chat.routes");
const groupRoutes = require("./src/routes/group.routes");
const passport = require("./src/config/passport");
const { connectRedis } = require("./src/config/redis");
const resetRoutes = require("./src/routes/reset.routes");

const port = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

// Initialize Passport
app.use(passport.initialize());

// Initialize Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Expose io to controllers via req.app.get("io")
app.set("io", io);

// Middleware
app.set("trust proxy", 1); // Required for Render/Koyeb/Vercel
app.use(
  cors({
    origin: [process.env.SITE_URL, "http://localhost:3000"],
    credentials: true,
  }),
);
app.use(express.json());

// Routes
app.use("/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/chat", groupRoutes);
app.use("/api", resetRoutes);

// Health check for Deployment (UptimeRobot/Heartbeat)
const { getIsRedisConnected } = require("./src/config/redis");
const mongoose = require("mongoose");

app.get("/health", (req, res) => {
  const dbStatus =
    mongoose.connection.readyState === 1 ? "Connected" : "Disconnected";
  const redisStatus = getIsRedisConnected() ? "Connected" : "Disconnected";

  const status = dbStatus === "Connected" ? 200 : 500;

  res.status(status).json({
    status: "ok",
    database: dbStatus,
    redis: redisStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.send("Hey buddy no tension I am [ConvoX Server] Running...");
});

// Initialize Socket.io handlers
socketHandler(io);

// Connect to database
connectDB();

// Connect redis
connectRedis();

server.listen(port, () => {
  console.log(`ConvoX Server is running on port ${port}`);
  console.log(`Socket.io is ready for connections`);
});
