const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const {
    followTag,
    getTrendingTags,
} = require("../controllers/feed.controller");

router.use(auth);

router.get("/trending", getTrendingTags);
router.post("/:tag/follow", followTag);

module.exports = router;
