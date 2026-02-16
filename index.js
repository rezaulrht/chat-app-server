require("dotenv").config();
const express = require('express');
const cors = require('cors');
const connectDB = require("./src/utility/db");
const authRoutes = require("./src/routes/auth.routes");

const port = process.env.PORT || 3000;
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/auth", authRoutes);

app.get('/', (req, res) => {
    res.send("Hey buddy no tension I am [ConvoX Server] Running...");
})

// Connect to database
connectDB();

app.listen(port, () => {
    console.log(`ConvoX Server is running on port ${port}`);
})