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
const resetRoutes = require("./src/routes/reset.routes");
const uploadRoutes = require("./src/routes/upload.routes"); // ← ADD THIS
const passport = require("./src/config/passport");
const { connectRedis, getIsRedisConnected } = require("./src/config/redis");
const scheduleRoutes = require("./src/routes/schedule.routes");
const workspaceRoutes = require("./src/routes/workspace.routes");
const moduleRoutes = require("./src/routes/module.routes");
const feedRoutes = require("./src/routes/feed.routes");
const pinRoutes = require("./src/routes/pin.routes");
const pollRoutes = require("./src/routes/poll.routes");
const feedUserRoutes = require("./src/routes/feed.users.routes");
const mongoose = require("mongoose");

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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Routes
app.use("/api/upload", uploadRoutes); // ← Upload routes
app.use("/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/chat", groupRoutes);
app.use("/api/reset", resetRoutes);
app.use("/api/chat/conversations/:id", pinRoutes); // Pin routes nested under conversations
app.use("/api/chat", pollRoutes); 

// Workspace Routes
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/workspaces/:workspaceId/modules", moduleRoutes);

// Feed Routes
app.use("/api/feed/posts", feedRoutes);
app.use("/api/feed/users", feedUserRoutes);

// Scheduled Message Routes
app.use("/api/messages", scheduleRoutes);

// Health check for Deployment (UptimeRobot/Heartbeat)
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

(async () => {
  try {
    // Connect to database
    await connectDB();
    console.log("MongoDB Connected");

    // Connect redis
    await connectRedis();
    console.log("Redis Connected");

    // Start Scheduler
    const startScheduler = require("./src/utility/scheduler");
    startScheduler(io);
    console.log("Scheduler Started");

    // Start server
    server.listen(port, () => {
      console.log(`ConvoX Server is running on port ${port}`);
      console.log(`Socket.io is ready for connections`);
    });
  } catch (error) {
    console.error("Server Startup Error:", error);
    process.exit(1);
  }
})();
