require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const connectDB = require("./src/utility/db");
const socketHandler = require("./src/utility/socket");
const authRoutes = require("./src/routes/auth.routes");

const port = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const passport = require("./src/config/passport");

// Initialize Passport
app.use(passport.initialize());

// Initialize Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // In production, specify your frontend URL
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/auth", authRoutes);

app.get("/", (req, res) => {
  res.send("Hey buddy no tension I am [ConvoX Server] Running...");
});

// Initialize Socket.io handlers
socketHandler(io);

// Connect to database
connectDB();

server.listen(port, () => {
  console.log(`ConvoX Server is running on port ${port}`);
  console.log(`Socket.io is ready for connections`);
});
