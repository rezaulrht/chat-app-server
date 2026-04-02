const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");

const {
    getComments,
    createComment,
    updateComment,
    deleteComment,
    reactToComment,
    getCommentReactions,
} = require("../controllers/feed.controller");

router.use(auth);

router.get("/", getComments);
router.post("/", createComment);
router.patch("/:id", updateComment);
router.delete("/:id", deleteComment);
router.post("/:id/react", reactToComment);
router.get("/:id/reactions", getCommentReactions);

module.exports = router;
