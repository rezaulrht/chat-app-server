const express = require("express");
const router = express.Router();

const postRoutes = require("./feed.routes");
const commentRoutes = require("./feed.comments.routes");
const tagRoutes = require("./feed.tags.routes");
const userRoutes = require("./feed.users.routes");
const searchRoutes = require("./feed.search.routes");

router.use("/posts", postRoutes);
router.use("/comments", commentRoutes);
router.use("/tags", tagRoutes);
router.use("/users", userRoutes);
router.use("/search", searchRoutes);

module.exports = router;
