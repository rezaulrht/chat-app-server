const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const { searchFeed } = require("../controllers/feed.controller");

router.use(auth);

router.get("/", searchFeed);

module.exports = router;
