/**
 * Feed socket handler — manages per-post rooms for real-time reaction updates.
 *
 * Clients join `feed:post:<id>` when viewing a post detail and leave on close.
 * The react REST controller broadcasts `feed:post:reacted` to this room.
 */
const mongoose = require("mongoose");
const Post = require("../models/Post");

module.exports = function registerFeedHandlers(socket) {
  socket.on("feed:user:join", (targetUserId) => {
    // Only allow joining own user room
    if (
      typeof targetUserId !== "string" ||
      !mongoose.Types.ObjectId.isValid(targetUserId) ||
      targetUserId !== socket.userId
    ) {
      socket.emit("feed:error", { message: "Not authorized to join this room" });
      return;
    }

    socket.join(`feed:user:${targetUserId}`);
  });

  socket.on("feed:user:leave", (targetUserId) => {
    // Only allow leaving own user room
    if (
      typeof targetUserId === "string" &&
      mongoose.Types.ObjectId.isValid(targetUserId) &&
      targetUserId === socket.userId
    ) {
      socket.leave(`feed:user:${targetUserId}`);
    }
  });

  socket.on("feed:post:join", async (postId) => {
    if (typeof postId !== "string" || !mongoose.Types.ObjectId.isValid(postId)) {
      socket.emit("feed:error", { message: "Invalid post id" });
      return;
    }

    try {
      const post = await Post.findById(postId).select("author isPrivate").lean();

      if (!post) {
        socket.emit("feed:error", { message: "Post not found" });
        return;
      }

      const isOwner = post.author.toString() === socket.userId;
      if (post.isPrivate && !isOwner) {
        socket.emit("feed:error", { message: "Not authorized to view this post" });
        return;
      }

      socket.join(`feed:post:${postId}`);
    } catch (err) {
      console.error("feed:post:join error:", err.message);
      socket.emit("feed:error", { message: "Server error" });
    }
  });

  socket.on("feed:post:leave", (postId) => {
    if (typeof postId === "string" && mongoose.Types.ObjectId.isValid(postId)) {
      socket.leave(`feed:post:${postId}`);
    }
  });

  socket.on("feed:global:join", () => {
    socket.join("feed:global");
  });

  socket.on("feed:global:leave", () => {
    socket.leave("feed:global");
  });
};
