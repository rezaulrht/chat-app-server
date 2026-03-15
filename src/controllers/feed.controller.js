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
    return { url: null, title: null, description: null, image: null };
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
            return { text: option.trim(), votes: [] };
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
  if (hasOwn(body, "title"))
    post.title = body.title ? String(body.title).trim() : null;
  if (hasOwn(body, "content"))
    post.content = body.content ? String(body.content) : "";
  if (hasOwn(body, "tags")) post.tags = normalizeTags(body.tags);
  if (hasOwn(body, "isPrivate")) post.isPrivate = Boolean(body.isPrivate);
  if (hasOwn(body, "codeBlocks"))
    post.codeBlocks = normalizeCodeBlocks(body.codeBlocks);
  if (hasOwn(body, "linkPreview"))
    post.linkPreview = normalizeLinkPreview(body.linkPreview);
  if (hasOwn(body, "screenshots"))
    post.screenshots = normalizeScreenshots(body.screenshots);
  if (hasOwn(body, "resourceCategory")) {
    post.resourceCategory = body.resourceCategory
      ? String(body.resourceCategory).trim()
      : null;
  }
  if (hasOwn(body, "poll")) post.poll = normalizePoll(body.poll);
  if (hasOwn(body, "status")) post.status = body.status;
};

const getEffectiveSort = (tab, sort) => {
  if (sort && SORT_PRESETS[sort]) return SORT_PRESETS[sort];
  if (tab && SORT_PRESETS[tab]) return SORT_PRESETS[tab];
  return SORT_PRESETS.latest;
};

// ---------------------------------------------------------------------------
// GET /api/feed/posts
// ---------------------------------------------------------------------------
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

    const filter = { $or: [{ isPrivate: false }, { author: userId }] };

    if (tab === "qa") {
      filter.type = "question";
    } else if (requestedType !== "all" && VALID_TYPES.includes(requestedType)) {
      filter.type = requestedType;
    }

    // Following tab — filter to posts by people this user follows
    if (tab === "following") {
      const me = await User.findById(userId).select("following");
      const followingIds = me?.following || [];
      filter.author = { $in: followingIds };
      // Remove private restriction for following feed
      delete filter.$or;
    }

    const tags = normalizeTags(req.query.tags);
    if (tags.length) {
      filter.tags = { $in: tags };
    }

    const effectiveSort = getEffectiveSort(tab, sort);

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate("author", "name avatar reputation")
        .sort(effectiveSort)
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    const hasMore = page * limit < total;

    res.json({ posts, total, page, hasMore });
  } catch (err) {
    console.error("getPosts error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/posts/:id
// ---------------------------------------------------------------------------
exports.getPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id).populate(
      "author",
      "name avatar reputation",
    );

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

// ---------------------------------------------------------------------------
// POST /api/feed/posts
// ---------------------------------------------------------------------------
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
      "name avatar reputation",
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

// ---------------------------------------------------------------------------
// PATCH /api/feed/posts/:id
// ---------------------------------------------------------------------------
exports.updatePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id);
    if (!post) return res.status(404).json({ message: "Post not found" });

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
    await post.populate("author", "name avatar reputation");

    res.json(post);
  } catch (err) {
    console.error("updatePost error:", err.message);
    if (err.name === "ValidationError" || err.message.includes("required")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/feed/posts/:id
// ---------------------------------------------------------------------------
exports.deletePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id);
    if (!post) return res.status(404).json({ message: "Post not found" });

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

// ---------------------------------------------------------------------------
// POST /api/feed/users/:id/follow
// Toggle follow / unfollow. Returns { following: Boolean }
// ---------------------------------------------------------------------------
exports.followUser = async (req, res) => {
  try {
    const targetId = req.params.id;
    const myId = req.user.id;

    if (targetId === myId) {
      return res.status(400).json({ message: "You cannot follow yourself" });
    }

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const [target, me] = await Promise.all([
      User.findById(targetId).select("_id name"),
      User.findById(myId).select("following"),
    ]);

    if (!target) return res.status(404).json({ message: "User not found" });
    if (!me) return res.status(404).json({ message: "User not found" });

    const alreadyFollowing = me.following.some(
      (uid) => uid.toString() === targetId,
    );

    if (alreadyFollowing) {
      await User.findByIdAndUpdate(myId, { $pull: { following: targetId } });
      await User.findByIdAndUpdate(targetId, { $pull: { followers: myId } });

      req.app.get("io").to(`feed:user:${targetId}`).emit("feed:follow", {
        followerId: myId,
        following: false,
      });

      return res.json({ following: false, message: "Unfollowed" });
    } else {
      await User.findByIdAndUpdate(myId, {
        $addToSet: { following: targetId },
      });
      await User.findByIdAndUpdate(targetId, {
        $addToSet: { followers: myId },
      });

      req.app.get("io").to(`feed:user:${targetId}`).emit("feed:follow", {
        followerId: myId,
        following: true,
      });

      return res.json({ following: true, message: "Followed" });
    }
  } catch (err) {
    console.error("followUser error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/users/:id/profile
// Public profile — user info + stats. Viewable by any authenticated user.
// ---------------------------------------------------------------------------
exports.getUserProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const myId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id).select(
      "name avatar bio statusMessage provider reputation following followers followedTags createdAt",
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const postCount = await Post.countDocuments({
      author: id,
      isPrivate: false,
    });

    const isFollowing = user.followers.some((uid) => uid.toString() === myId);

    return res.json({
      _id: user._id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      statusMessage: user.statusMessage,
      provider: user.provider,
      reputation: user.reputation,
      followingCount: user.following.length,
      followersCount: user.followers.length,
      followedTags: user.followedTags,
      postCount,
      isFollowing,
      isOwnProfile: id === myId,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error("getUserProfile error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/users/:id/posts
// User's published posts — paginated.
// ---------------------------------------------------------------------------
exports.getUserPosts = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id).select("_id");
    if (!user) return res.status(404).json({ message: "User not found" });

    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      Post.find({ author: id, isPrivate: false })
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", "name avatar reputation"),
      Post.countDocuments({ author: id, isPrivate: false }),
    ]);

    const hasMore = skip + posts.length < total;

    return res.json({ posts, hasMore, total, page });
  } catch (err) {
    console.error("getUserPosts error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/users/top-contributors
// Leaderboard — top 10 users by reputation.
// ---------------------------------------------------------------------------
exports.getTopContributors = async (req, res) => {
  try {
    const users = await User.find({ reputation: { $gt: 0 } })
      .sort({ reputation: -1 })
      .limit(10)
      .select("name avatar reputation followers");

    const leaderboard = users.map((u) => ({
      _id: u._id,
      name: u.name,
      avatar: u.avatar,
      reputation: u.reputation,
      followersCount: u.followers.length,
    }));

    return res.json(leaderboard);
  } catch (err) {
    console.error("getTopContributors error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/posts/:id/react
// Toggle emoji reaction on a post.
// ---------------------------------------------------------------------------
exports.reactToPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { emoji } = req.body;

    if (!emoji || !emoji.trim()) {
      return res.status(400).json({ message: "Emoji is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const post = await Post.findById(id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const reactions = post.reactions || new Map();
    const currentUsers = reactions.get(emoji) || [];
    const alreadyReacted = currentUsers.map(String).includes(userId);

    if (alreadyReacted) {
      const updated = currentUsers.filter((uid) => uid.toString() !== userId);
      if (updated.length === 0) reactions.delete(emoji);
      else reactions.set(emoji, updated);
    } else {
      reactions.set(emoji, [...currentUsers, userId]);
    }

    post.reactions = reactions;

    let total = 0;
    for (const users of post.reactions.values()) total += users.length;
    post.reactionCount = total;

    await post.save();

    const reactionsObj = {};
    for (const [key, val] of post.reactions.entries()) {
      reactionsObj[key] = val;
    }

    req.app.get("io").to(`feed:post:${id}`).emit("feed:post:reacted", {
      postId: id,
      reactions: reactionsObj,
      reactionCount: post.reactionCount,
    });

    if (post.author.toString() !== userId) {
      await User.findByIdAndUpdate(post.author, {
        $inc: { reputation: alreadyReacted ? -2 : 2 },
      });
    }

    return res.json({
      reactions: reactionsObj,
      reactionCount: post.reactionCount,
    });
  } catch (err) {
    console.error("reactToPost error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};
