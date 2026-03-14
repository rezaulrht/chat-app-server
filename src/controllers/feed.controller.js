const mongoose = require("mongoose");
const Post = require("../models/Post");
const User = require("../models/User");

const VALID_TYPES = [
  "post",
  "question",
  "til",
  "snippet",
  "showcase",
  "poll",
  "resource",
];

const SORT_PRESETS = {
  latest: { isPinned: -1, createdAt: -1 },
  trending: { commentsCount: -1, createdAt: -1 },
  top: { commentsCount: -1, createdAt: -1 },
  oldest: { createdAt: 1 },
};

const LEVELS = [
  { min: 0,   max: 49,  level: "Newcomer",    badge: "🟢" },
  { min: 50,  max: 199, level: "Contributor",  badge: "🔵" },
  { min: 200, max: 499, level: "Expert",       badge: "🟣" },
  { min: 500, max: Infinity, level: "Legend",  badge: "🟡" },
];

function getLevel(reputation) {
  return LEVELS.find((l) => reputation >= l.min && reputation <= l.max) ?? LEVELS[0];
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const normalizeTags = (tags) => {
  if (!tags) return [];

  const source = Array.isArray(tags)
    ? tags
    : String(tags)
        .split(",")
        .map((tag) => tag.trim());

  const deduped = [];
  const seen = new Set();

  for (const tag of source) {
    const value = String(tag || "")
      .trim()
      .toLowerCase();
    if (!value || seen.has(value)) continue;
    deduped.push(value);
    seen.add(value);
    if (deduped.length >= 5) break;
  }

  return deduped;
};

const normalizeCodeBlocks = (codeBlocks) => {
  if (!Array.isArray(codeBlocks)) return [];

  return codeBlocks
    .map((item) => ({
      filename: String(item?.filename || "snippet.txt").trim() || "snippet.txt",
      language: String(item?.language || "text").trim() || "text",
      code: String(item?.code || ""),
    }))
    .filter((item) => item.code.trim().length > 0)
    .slice(0, 10);
};

const normalizeScreenshots = (screenshots) => {
  if (!Array.isArray(screenshots)) return [];
  return screenshots
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .slice(0, 10);
};

const normalizeLinkPreview = (linkPreview) => {
  if (!linkPreview || typeof linkPreview !== "object") {
    return {
      url: null,
      title: null,
      description: null,
      image: null,
    };
  }

  return {
    url: linkPreview.url ? String(linkPreview.url).trim() : null,
    title: linkPreview.title ? String(linkPreview.title).trim() : null,
    description: linkPreview.description
      ? String(linkPreview.description).trim()
      : null,
    image: linkPreview.image ? String(linkPreview.image).trim() : null,
  };
};

const parsePollDuration = (duration) => {
  const raw = String(duration || "")
    .toLowerCase()
    .trim();
  if (!raw) return null;

  if (raw.includes("1 day") || raw === "24h") return 1;
  if (raw.includes("3 day") || raw === "72h") return 3;
  if (raw.includes("7 day")) return 7;
  if (raw.includes("14 day") || raw.includes("2 week")) return 14;
  if (raw.includes("30 day") || raw.includes("1 month")) return 30;

  return null;
};

const normalizePoll = (poll) => {
  if (!poll || typeof poll !== "object") {
    return {
      question: null,
      options: [],
      multiSelect: false,
      duration: "7 Days",
      endsAt: null,
      visibility: "Public",
    };
  }

  const options = Array.isArray(poll.options)
    ? poll.options
        .map((option) => {
          if (typeof option === "string") {
            return {
              text: option.trim(),
              votes: [],
            };
          }

          return {
            text: String(option?.text || "").trim(),
            votes: Array.isArray(option?.votes) ? option.votes : [],
          };
        })
        .filter((option) => option.text)
        .slice(0, 6)
    : [];

  const duration = poll.duration ? String(poll.duration).trim() : "7 Days";
  const durationDays = parsePollDuration(duration);
  const endsAt = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    question: poll.question ? String(poll.question).trim() : null,
    options,
    multiSelect: Boolean(poll.multiSelect),
    duration,
    endsAt,
    visibility: poll.visibility ? String(poll.visibility).trim() : "Public",
  };
};

const normalizePostPayload = (body) => {
  const payload = {
    type: body.type,
    title: body.title ? String(body.title).trim() : null,
    content: body.content ? String(body.content) : "",
    tags: normalizeTags(body.tags),
    isPrivate: Boolean(body.isPrivate),
  };

  if (hasOwn(body, "isPinned")) payload.isPinned = Boolean(body.isPinned);
  if (hasOwn(body, "status")) payload.status = body.status;

  if (hasOwn(body, "codeBlocks"))
    payload.codeBlocks = normalizeCodeBlocks(body.codeBlocks);
  if (hasOwn(body, "screenshots"))
    payload.screenshots = normalizeScreenshots(body.screenshots);
  if (hasOwn(body, "resourceCategory")) {
    payload.resourceCategory = body.resourceCategory
      ? String(body.resourceCategory).trim()
      : null;
  }
  if (hasOwn(body, "linkPreview"))
    payload.linkPreview = normalizeLinkPreview(body.linkPreview);
  if (hasOwn(body, "poll")) payload.poll = normalizePoll(body.poll);

  return payload;
};

const applyUpdatePayload = (post, body) => {
  if (hasOwn(body, "title")) {
    post.title = body.title ? String(body.title).trim() : null;
  }

  if (hasOwn(body, "content")) {
    post.content = body.content ? String(body.content) : "";
  }

  if (hasOwn(body, "tags")) {
    post.tags = normalizeTags(body.tags);
  }

  if (hasOwn(body, "isPrivate")) {
    post.isPrivate = Boolean(body.isPrivate);
  }

  if (hasOwn(body, "codeBlocks")) {
    post.codeBlocks = normalizeCodeBlocks(body.codeBlocks);
  }

  if (hasOwn(body, "linkPreview")) {
    post.linkPreview = normalizeLinkPreview(body.linkPreview);
  }

  if (hasOwn(body, "screenshots")) {
    post.screenshots = normalizeScreenshots(body.screenshots);
  }

  if (hasOwn(body, "resourceCategory")) {
    post.resourceCategory = body.resourceCategory
      ? String(body.resourceCategory).trim()
      : null;
  }

  if (hasOwn(body, "poll")) {
    post.poll = normalizePoll(body.poll);
  }

  if (hasOwn(body, "status")) {
    post.status = body.status;
  }
};

const getEffectiveSort = (tab, sort) => {
  if (sort && SORT_PRESETS[sort]) {
    return SORT_PRESETS[sort];
  }

  if (tab && SORT_PRESETS[tab]) {
    return SORT_PRESETS[tab];
  }

  return SORT_PRESETS.latest;
};

// @desc    Get paginated feed posts
// @route   GET /api/feed/posts?tab=&page=&limit=&type=&tags=&sort=
exports.getPosts = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const skip = (page - 1) * limit;

    const tab = req.query.tab ? String(req.query.tab).toLowerCase() : "latest";
    const requestedType = req.query.type
      ? String(req.query.type).toLowerCase()
      : "all";
    const sort = req.query.sort ? String(req.query.sort).toLowerCase() : null;

    const filter = {
      $or: [{ isPrivate: false }, { author: userId }],
    };

    if (tab === "qa") {
      filter.type = "question";
    } else if (requestedType !== "all" && VALID_TYPES.includes(requestedType)) {
      filter.type = requestedType;
    }

    const tags = normalizeTags(req.query.tags);
    if (tags.length) {
      filter.tags = { $in: tags };
    }

    // NOTE: "following" tab currently falls back to normal feed because
    // following-user/tag graph is not yet stored in User schema.

    const effectiveSort = getEffectiveSort(tab, sort);

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate("author", "name avatar")
        .sort(effectiveSort)
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    const hasMore = page * limit < total;

    res.json({
      posts,
      total,
      page,
      hasMore,
    });
  } catch (err) {
    console.error("getPosts error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get single post by id
// @route   GET /api/feed/posts/:id
exports.getPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id).populate("author", "name avatar");

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const isOwner = post.author?._id?.toString() === userId;
    if (post.isPrivate && !isOwner) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.json(post);
  } catch (err) {
    console.error("getPost error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create new post
// @route   POST /api/feed/posts
exports.createPost = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!VALID_TYPES.includes(req.body.type)) {
      return res.status(400).json({ message: "Invalid post type" });
    }

    const payload = normalizePostPayload(req.body);
    payload.author = userId;

    const created = await Post.create(payload);
    const post = await Post.findById(created._id).populate(
      "author",
      "name avatar",
    );

    res.status(201).json(post);
  } catch (err) {
    console.error("createPost error:", err.message);
    if (err.name === "ValidationError" || err.message.includes("required")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update an existing post
// @route   PATCH /api/feed/posts/:id
exports.updatePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.author.toString() !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this post" });
    }

    if (hasOwn(req.body, "type") && req.body.type !== post.type) {
      return res.status(400).json({ message: "Post type cannot be changed" });
    }

    applyUpdatePayload(post, req.body);
    await post.save();
    await post.populate("author", "name avatar");

    res.json(post);
  } catch (err) {
    console.error("updatePost error:", err.message);
    if (err.name === "ValidationError" || err.message.includes("required")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Delete a post
// @route   DELETE /api/feed/posts/:id
exports.deletePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.author.toString() !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to delete this post" });
    }

    await Post.deleteOne({ _id: id });

    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("deletePost error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Toggle a reaction on a post
// @route   POST /api/feed/posts/:id/react
exports.reactToPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { emoji } = req.body;

    // Use 20 chars to accommodate multi-codepoint emoji sequences (family, flag, etc.)
    if (!emoji || typeof emoji !== "string" || emoji.length > 20) {
      return res.status(400).json({ message: "emoji is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Fetch post to determine add vs remove and get author id
    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const authorId = post.author.toString();
    const isSelf = authorId === userId;

    // Check current reaction state before any writes
    const existingUsers = (post.reactions?.get(emoji) ?? []).map(String);
    const isAdding = !existingUsers.includes(userId);

    let updatedPost;

    if (isAdding) {
      // Add reaction atomically
      updatedPost = await Post.findByIdAndUpdate(
        id,
        {
          $addToSet: { [`reactions.${emoji}`]: userId },
          $inc: { reactionCount: 1 },
        },
        { returnDocument: "after" },
      );

      // Bonus guard — only the first writer whose filter matches wins.
      // MongoDB document-level atomicity ensures only one concurrent caller
      // can set bonus5Reactions: true (the second will find it already true).
      const bonusResult = await Post.findOneAndUpdate(
        { _id: id, bonus5Reactions: false, reactionCount: { $gte: 5 } },
        { $set: { bonus5Reactions: true } },
      );

      if (!isSelf) {
        // +2 for the reaction; +5 if bonus was just triggered
        const bonusDelta = bonusResult ? 5 : 0;
        const delta = 2 + bonusDelta;
        await User.findByIdAndUpdate(authorId, { $inc: { reputation: delta } });
      }
    } else {
      // Remove reaction.
      // NOTE: $inc bypasses Mongoose min:0, so we compute the new count
      // from the pre-read post value and use $set to guarantee no negatives.
      // Bonuses already awarded are permanent — un-reacting does NOT reverse
      // the one-time +5 milestone bonus (intentional design decision).
      // Edge case: if bonus5Reactions was set to true via self-reacts only
      // (no +5 awarded), a later non-author reaction will NOT re-trigger the bonus.
      // This is also intentional — the bonus requires another user to push to 5+.
      const newCount = Math.max(0, (post.reactionCount ?? 0) - 1);
      updatedPost = await Post.findByIdAndUpdate(
        id,
        {
          $pull: { [`reactions.${emoji}`]: userId },
          $set: { reactionCount: newCount },
        },
        { returnDocument: "after" },
      );

      if (!isSelf) {
        // Decrement only if reputation >= 2 to stay floored at 0;
        // if it was 0 or 1, clamp to 0 explicitly.
        const floored = await User.findOneAndUpdate(
          { _id: authorId, reputation: { $gte: 2 } },
          { $inc: { reputation: -2 } },
        );
        if (!floored) {
          await User.findByIdAndUpdate(authorId, { $set: { reputation: 0 } });
        }
      }
    }

    // Guard against null in case the post was deleted between reads
    if (!updatedPost) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Build plain reactions object from Map
    const reactions = {};
    if (updatedPost.reactions) {
      for (const [key, value] of updatedPost.reactions.entries()) {
        reactions[key] = value.map(String);
      }
    }

    // Broadcast to all clients viewing this post
    const io = req.app.get("io");
    io.to(`feed:post:${id}`).emit("feed:post:reacted", {
      postId: id,
      reactions,
      reactionCount: updatedPost.reactionCount,
    });

    res.json({ reactions, reactionCount: updatedPost.reactionCount });
  } catch (err) {
    console.error("reactToPost error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get current user's feed stats (reputation, level, postCount)
// @route   GET /api/feed/me/stats
exports.getMyStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, postCount] = await Promise.all([
      User.findById(userId, "reputation"),
      Post.countDocuments({ author: userId, isPrivate: false }),
    ]);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const reputation = user.reputation ?? 0;
    const { level, badge } = getLevel(reputation);

    res.json({ reputation, level, badge, postCount });
  } catch (err) {
    console.error("getMyStats error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};
