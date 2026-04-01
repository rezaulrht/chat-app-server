const mongoose = require("mongoose");
const Post = require("../models/Post");
const Comment = require("../models/Comment");
const User = require("../models/User");
const NotificationService = require("../services/notification.service");
const createHelpers = require("../socket/helpers");

const FEED_REPUTATION = {
  POST_CREATE: 3,
  POST_REACTION: 2,
  COMMENT_REACTION: 1,
  ACCEPTED_ANSWER: 15,
  QUESTION_BONUS: 5,
};

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
  trending: {
    isPinned: -1,
    reactionCount: -1,
    commentsCount: -1,
    createdAt: -1,
  },
  top: { reactionCount: -1, commentsCount: -1, createdAt: -1 },
  oldest: { createdAt: 1 },
};

const LEVELS = [
  { min: 0, max: 49, level: "Newcomer", badge: "🌱" },
  { min: 50, max: 199, level: "Contributor", badge: "⚡" },
  { min: 200, max: 499, level: "Expert", badge: "🔥" },
  { min: 500, max: Infinity, level: "Legend", badge: "🏆" },
];

function getLevel(reputation) {
  return (
    LEVELS.find((l) => reputation >= l.min && reputation <= l.max) ?? LEVELS[0]
  );
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const getIo = (req) => req.app.get("io");

/**
 * Broadcast a lightweight event so every connected client (leaderboard sidebar,
 * profile cards, etc.) knows to re-fetch reputation data for this user.
 * Non-fatal — wrapped in try/catch so it never breaks the request.
 */
const emitReputationUpdated = (io, userId) => {
  try {
    io.emit("feed:reputation:updated", { userId: String(userId) });
  } catch (_) {}
};

const toPlainReactions = (reactionMap) => {
  const reactionsObj = {};
  for (const [key, val] of reactionMap.entries()) {
    reactionsObj[key] = val;
  }
  return reactionsObj;
};

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

// Helper to check post access (privacy and ownership)
const checkPostAccess = async (postId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return { error: { status: 400, message: "Invalid post ID" } };
  }

  const post = await Post.findById(postId).select("_id author isPrivate");
  if (!post) {
    return { error: { status: 404, message: "Post not found" } };
  }

  const isOwner = post.author?.toString?.() === userId;
  if (post.isPrivate && !isOwner) {
    return {
      error: { status: 403, message: "Not authorized to access this post" },
    };
  }

  return { post };
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

const SAFE_URL_RE = /^https?:\/\//i;

const sanitizeUrl = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  return SAFE_URL_RE.test(s) ? s : null;
};

const normalizeLinkPreview = (linkPreview) => {
  if (!linkPreview || typeof linkPreview !== "object") {
    return { url: null, title: null, description: null, image: null };
  }

  return {
    url: sanitizeUrl(linkPreview.url),
    title: linkPreview.title ? String(linkPreview.title).trim() : null,
    description: linkPreview.description
      ? String(linkPreview.description).trim()
      : null,
    image: sanitizeUrl(linkPreview.image),
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

const normalizePoll = (poll, existingPoll = null) => {
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
          const text = String(option?.text || "").trim();
          // Preserve votes from existingPoll if available, otherwise initialize to []
          let votes = [];
          if (existingPoll && Array.isArray(existingPoll.options)) {
            const existing = existingPoll.options.find(
              (opt) => opt.text === text,
            );
            if (existing && Array.isArray(existing.votes)) {
              votes = existing.votes;
            }
          }
          return { text, votes };
        })
        .filter((option) => option.text)
        .slice(0, 6)
    : [];

  const duration = poll.duration ? String(poll.duration).trim() : "7 Days";
  const durationDays = parsePollDuration(duration);

  // Use existing endsAt if updating, only compute for new polls
  let endsAt = null;
  if (existingPoll && existingPoll.endsAt) {
    endsAt = existingPoll.endsAt;
  } else if (durationDays) {
    endsAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
  }

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
  // Tab-driven views (trending, top) always use their own sort — the UI
  // sort selector is irrelevant when a sort-defining tab is active.
  if (tab === "trending" || tab === "top") return SORT_PRESETS[tab];
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
    const q = req.query.q ? String(req.query.q).trim() : "";

    const filter = { $or: [{ isPrivate: false }, { author: userId }] };

    if (tab === "qa") {
      filter.type = "question";
    } else if (requestedType !== "all" && VALID_TYPES.includes(requestedType)) {
      filter.type = requestedType;
    }

    // Following tab - filter to posts by people this user follows.
    if (tab === "following") {
      const me = await User.findById(userId).select("following");
      const followingIds = me?.following || [];
      filter.$or = [
        { isPrivate: false, author: { $in: followingIds } },
        { author: userId },
      ];
    }

    if (tab === "trending") {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: since };
    }

    const tags = normalizeTags(req.query.tags);
    if (tags.length) {
      filter.tags = { $in: tags };
    }

    if (q) {
      filter.$text = { $search: q };
    }

    const effectiveSort = getEffectiveSort(tab, sort);

    const projection = q ? { score: { $meta: "textScore" } } : null;

    const sortWithText = q
      ? { score: { $meta: "textScore" }, ...effectiveSort }
      : effectiveSort;

    const [posts, total] = await Promise.all([
      Post.find(filter, projection)
        .populate("author", "name avatar reputation")
        .sort(sortWithText)
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

    const io = getIo(req);
    // Only emit to global feed if post is public
    if (!post.isPrivate) {
      io.emit("feed:post:created", { post });
    }
    io.to(`feed:user:${userId}`).emit("feed:user:post-created", {
      authorId: userId,
      postId: post._id,
    });

    // Grant reputation for publishing a post (non-fatal)
    try {
      await User.findByIdAndUpdate(userId, [
        {
          $set: {
            reputation: { $add: ["$reputation", FEED_REPUTATION.POST_CREATE] },
          },
        },
      ]);
      emitReputationUpdated(io, userId);
    } catch (repErr) {
      console.warn(
        "createPost: reputation update failed (non-fatal):",
        repErr.message,
      );
    }

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

    await Promise.all([
      Post.deleteOne({ _id: id }),
      Comment.deleteMany({ post: id }),
    ]);

    const io = getIo(req);
    io.to(`feed:post:${id}`).emit("feed:post:deleted", { postId: id });

    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("deletePost error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/users/:id/follow
// GET /api/feed/users/:id/followers
exports.getFollowers = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid user ID" });

    const user = await User.findById(id)
      .select("followers")
      .populate({ path: "followers", select: "name avatar reputation" });

    if (!user) return res.status(404).json({ message: "User not found" });

    const followers = (user.followers || []).map((f) => ({
      _id: f._id,
      name: f.name,
      avatar: f.avatar,
      reputation: f.reputation ?? 0,
    }));

    return res.json({ followers, total: followers.length });
  } catch (err) {
    console.error("getFollowers error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

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

      const { emitToUser } = createHelpers(req.app.get("io"));
      await NotificationService.push(emitToUser, {
        recipientId: targetId,
        type: "feed_follow",
        actorId: myId,
        data: {},
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

    const { level, badge } = getLevel(user.reputation);

    return res.json({
      _id: user._id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      statusMessage: user.statusMessage,
      provider: user.provider,
      reputation: user.reputation,
      level,
      badge,
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
    const users = await User.find({})
      .sort({ reputation: -1 })
      .limit(10)
      .select("name avatar reputation followers");

    const userIds = users.map((u) => u._id);
    const postCounts = await Post.aggregate([
      { $match: { author: { $in: userIds }, isPrivate: false } },
      { $group: { _id: "$author", count: { $sum: 1 } } },
    ]);
    const postCountMap = {};
    for (const { _id, count } of postCounts) postCountMap[String(_id)] = count;

    const leaderboard = users.map((u) => {
      const { level, badge } = getLevel(u.reputation);
      return {
        _id: u._id,
        name: u.name,
        avatar: u.avatar,
        reputation: u.reputation,
        level,
        badge,
        followersCount: u.followers.length,
        postCount: postCountMap[String(u._id)] ?? 0,
      };
    });

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

    // Check post access (privacy/ownership)
    const access = await checkPostAccess(id, userId);
    if (access.error) {
      return res
        .status(access.error.status)
        .json({ message: access.error.message });
    }
    const post = access.post;
    // Reload post with full data for reactions
    const fullPost = await Post.findById(id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const reactions = fullPost.reactions || new Map();
    const currentUsers = reactions.get(emoji) || [];
    const alreadyReacted = currentUsers.map(String).includes(userId);

    if (alreadyReacted) {
      const updated = currentUsers.filter((uid) => uid.toString() !== userId);
      if (updated.length === 0) reactions.delete(emoji);
      else reactions.set(emoji, updated);
    } else {
      reactions.set(emoji, [...currentUsers, userId]);
    }

    fullPost.reactions = reactions;

    let total = 0;
    for (const users of fullPost.reactions.values()) total += users.length;
    fullPost.reactionCount = total;

    await fullPost.save();

    // ── Notification (only when adding a reaction, not removing) ──
    if (!alreadyReacted && fullPost.author.toString() !== userId) {
      const { emitToUser } = createHelpers(getIo(req));
      await NotificationService.push(emitToUser, {
        recipientId: fullPost.author.toString(),
        type: "feed_reaction",
        actorId: userId,
        data: {
          postId: id,
          postTitle: fullPost.title || "",
        },
      });
    }

    const reactionsObj = toPlainReactions(fullPost.reactions);

    const io = getIo(req);
    io.to(`feed:post:${id}`).emit("feed:post:reacted", {
      postId: id,
      reactions: reactionsObj,
      reactionCount: fullPost.reactionCount,
    });
    io.emit("feed:post:reaction-updated", {
      postId: id,
      reactionCount: fullPost.reactionCount,
    });

    // Reputation update is non-fatal — wrapped separately
    if (fullPost.author.toString() !== userId) {
      try {
        const repDelta = alreadyReacted
          ? -FEED_REPUTATION.POST_REACTION
          : FEED_REPUTATION.POST_REACTION;
        // Aggregation-pipeline update ensures reputation never falls below 0
        await User.findByIdAndUpdate(fullPost.author, [
          {
            $set: {
              reputation: { $max: [0, { $add: ["$reputation", repDelta] }] },
            },
          },
        ]);
        emitReputationUpdated(io, fullPost.author);
      } catch (repErr) {
        console.warn(
          "reactToPost: reputation update failed (non-fatal):",
          repErr.message,
        );
      }
    }

    return res.json({
      reactions: reactionsObj,
      reactionCount: fullPost.reactionCount,
    });
  } catch (err) {
    console.error("reactToPost error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/comments?postId=<id>&page=&limit=
// List comments with one-level replies.
// ---------------------------------------------------------------------------
exports.getComments = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const postId = req.query.postId;

    // Check post access (privacy/ownership)
    const access = await checkPostAccess(postId, userId);
    if (access.error) {
      return res
        .status(access.error.status)
        .json({ message: access.error.message });
    }

    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    const [roots, total] = await Promise.all([
      Comment.find({ post: postId, parentComment: null })
        .populate("author", "name avatar reputation")
        .sort({ isAccepted: -1, createdAt: 1 })
        .skip(skip)
        .limit(limit),
      Comment.countDocuments({ post: postId, parentComment: null }),
    ]);

    const rootIds = roots.map((c) => c._id);
    const replies = await Comment.find({
      post: postId,
      parentComment: { $in: rootIds },
    })
      .populate("author", "name avatar reputation")
      .sort({ createdAt: 1 });

    const repliesByParent = new Map();
    for (const reply of replies) {
      const key = reply.parentComment.toString();
      const list = repliesByParent.get(key) || [];
      list.push(reply);
      repliesByParent.set(key, list);
    }

    const comments = roots.map((root) => ({
      ...root.toObject(),
      replies: repliesByParent.get(root._id.toString()) || [],
    }));

    return res.json({
      comments,
      total,
      page,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error("getComments error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/comments
// Create a top-level comment or a one-level reply.
// ---------------------------------------------------------------------------
exports.createComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { postId, content, parentCommentId = null } = req.body;

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ message: "Invalid post ID" });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: "Comment content is required" });
    }

    // Check post access (privacy/ownership)
    const access = await checkPostAccess(postId, userId);
    if (access.error) {
      return res
        .status(access.error.status)
        .json({ message: access.error.message });
    }
    const post = access.post;

    // Reload post with more fields if needed
    const fullPost = await Post.findById(postId).select(
      "_id author type questionBonusAwarded isPrivate",
    );
    if (!fullPost) return res.status(404).json({ message: "Post not found" });

    let parentComment = null;
    if (parentCommentId) {
      if (!mongoose.Types.ObjectId.isValid(parentCommentId)) {
        return res.status(400).json({ message: "Invalid parent comment ID" });
      }
      parentComment = await Comment.findById(parentCommentId).select(
        "_id parentComment post",
      );
      if (!parentComment || parentComment.post.toString() !== postId) {
        return res.status(404).json({ message: "Parent comment not found" });
      }
      if (parentComment.parentComment) {
        return res
          .status(400)
          .json({ message: "Only 1-level replies are allowed" });
      }
    }

    const created = await Comment.create({
      post: postId,
      author: userId,
      parentComment: parentComment ? parentComment._id : null,
      content: String(content).trim(),
    });

    await Post.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });

    // First answer bonus for question author (conditional update prevents race)
    if (fullPost.type === "question" && fullPost.author.toString() !== userId) {
      const updated = await Post.findOneAndUpdate(
        { _id: postId, type: "question", questionBonusAwarded: false },
        { $set: { questionBonusAwarded: true } },
        { new: false },
      );
      // Only increment reputation if the conditional update succeeded
      if (updated) {
        await User.findByIdAndUpdate(fullPost.author, {
          $inc: { reputation: FEED_REPUTATION.QUESTION_BONUS },
        });
        emitReputationUpdated(getIo(req), fullPost.author);
      }
    }

    const comment = await Comment.findById(created._id).populate(
      "author",
      "name avatar reputation",
    );

    const io = getIo(req);
    io.to(`feed:post:${postId}`).emit("feed:comment:created", { comment });

    // ── Notification ─────────────────────────────────────────────
    if (fullPost.author.toString() !== userId) {
      const { emitToUser } = createHelpers(getIo(req));
      await NotificationService.push(emitToUser, {
        recipientId: fullPost.author.toString(),
        type: "feed_comment",
        actorId: userId,
        data: {
          postId: postId,
          postTitle:
            fullPost.type === "question" ? "your question" : "your post",
        },
      });
    }

    return res.status(201).json(comment);
  } catch (err) {
    console.error("createComment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/feed/comments/:id
// ---------------------------------------------------------------------------
exports.updateComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { content } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Comment not found" });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: "Comment content is required" });
    }

    const comment = await Comment.findById(id);
    if (!comment) return res.status(404).json({ message: "Comment not found" });
    if (comment.author.toString() !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    comment.content = String(content).trim();
    await comment.save();
    await comment.populate("author", "name avatar reputation");

    return res.json(comment);
  } catch (err) {
    console.error("updateComment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/feed/comments/:id
// ---------------------------------------------------------------------------
exports.deleteComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Comment not found" });
    }

    const comment = await Comment.findById(id);
    if (!comment) return res.status(404).json({ message: "Comment not found" });
    if (comment.author.toString() !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Load post to check/unwind acceptedComment state
    const post = await Post.findById(comment.post).select(
      "acceptedComment status author",
    );
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Check if deleting comment is the accepted answer and unwind it
    const deleteFilter = { $or: [{ _id: id }, { parentComment: id }] };
    const allToDelete = await Comment.find(deleteFilter).select(
      "_id author isAccepted",
    );
    const deleteIds = new Set(allToDelete.map((c) => c._id.toString()));
    const isAcceptedBeingDeleted = allToDelete.some(
      (c) => String(c._id) === String(post.acceptedComment),
    );

    if (isAcceptedBeingDeleted && post.acceptedComment) {
      // Unwind accepted answer state
      const acceptedAuthor = await Comment.findById(
        post.acceptedComment,
      ).select("author");
      if (acceptedAuthor) {
        await User.findByIdAndUpdate(acceptedAuthor.author, {
          $inc: { reputation: -FEED_REPUTATION.ACCEPTED_ANSWER },
        });
      }
      await Post.findByIdAndUpdate(post._id, {
        acceptedComment: null,
        status: "open",
      });
    }

    const deleteFilter2 = { $or: [{ _id: id }, { parentComment: id }] };
    const toDelete = await Comment.countDocuments(deleteFilter2);
    await Comment.deleteMany(deleteFilter2);

    const deletedCount = Math.max(1, toDelete);

    // Recompute from source of truth to avoid drift and pipeline compatibility issues.
    const remainingComments = await Comment.countDocuments({
      post: comment.post,
    });
    const updatedPost = await Post.findByIdAndUpdate(
      comment.post,
      { $set: { commentsCount: Math.max(0, remainingComments) } },
      { new: true },
    ).select("commentsCount");

    try {
      const io = getIo(req);
      io.to(`feed:post:${comment.post.toString()}`).emit(
        "feed:comment:deleted",
        {
          commentId: id,
          postId: comment.post,
          commentsCount: updatedPost?.commentsCount ?? 0,
        },
      );
    } catch (socketErr) {
      console.warn(
        "deleteComment socket emit failed (non-fatal):",
        socketErr.message,
      );
    }

    return res.json({
      message: "Deleted",
      deletedCount,
      commentsCount: updatedPost?.commentsCount ?? 0,
    });
  } catch (err) {
    console.error("deleteComment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/comments/:id/react
// Toggle emoji reaction on a comment.
// ---------------------------------------------------------------------------
exports.reactToComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { emoji } = req.body;

    if (!emoji || !emoji.trim()) {
      return res.status(400).json({ message: "Emoji is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Comment not found" });
    }

    const comment = await Comment.findById(id);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    // Check post access (privacy/ownership) before allowing reaction
    const access = await checkPostAccess(comment.post, userId);
    if (access.error) {
      return res
        .status(access.error.status)
        .json({ message: access.error.message });
    }

    const reactions = comment.reactions || new Map();
    const currentUsers = reactions.get(emoji) || [];
    const alreadyReacted = currentUsers.map(String).includes(userId);

    if (alreadyReacted) {
      const updated = currentUsers.filter((uid) => uid.toString() !== userId);
      if (updated.length === 0) reactions.delete(emoji);
      else reactions.set(emoji, updated);
    } else {
      reactions.set(emoji, [...currentUsers, userId]);
    }

    comment.reactions = reactions;

    let total = 0;
    for (const users of comment.reactions.values()) total += users.length;
    comment.reactionCount = total;
    await comment.save();

    if (comment.author.toString() !== userId) {
      try {
        const repDelta = alreadyReacted
          ? -FEED_REPUTATION.COMMENT_REACTION
          : FEED_REPUTATION.COMMENT_REACTION;
        // Aggregation-pipeline update ensures reputation never falls below 0
        await User.findByIdAndUpdate(comment.author, [
          {
            $set: {
              reputation: { $max: [0, { $add: ["$reputation", repDelta] }] },
            },
          },
        ]);
        emitReputationUpdated(getIo(req), comment.author);
      } catch (repErr) {
        console.warn(
          "reactToComment: reputation update failed (non-fatal):",
          repErr.message,
        );
      }
    }

    const reactionsObj = toPlainReactions(comment.reactions);
    getIo(req)
      .to(`feed:post:${comment.post.toString()}`)
      .emit("feed:comment:reacted", {
        postId: comment.post,
        commentId: comment._id,
        reactions: reactionsObj,
        reactionCount: comment.reactionCount,
      });

    return res.json({
      reactions: reactionsObj,
      reactionCount: comment.reactionCount,
    });
  } catch (err) {
    console.error("reactToComment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/posts/:postId/accept/:commentId
// Mark a comment as accepted answer for a question.
// ---------------------------------------------------------------------------
exports.toggleAcceptedAnswer = async (req, res) => {
  try {
    const userId = req.user.id;
    const { postId, commentId } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(postId) ||
      !mongoose.Types.ObjectId.isValid(commentId)
    ) {
      return res.status(400).json({ message: "Invalid ID" });
    }

    // Use transaction for atomic updates
    const session = await Post.startSession();
    session.startTransaction();

    try {
      const post = await Post.findById(postId).session(session);
      const comment = await Comment.findById(commentId).session(session);

      if (!post || !comment || comment.post.toString() !== postId) {
        await session.abortTransaction();
        return res.status(404).json({ message: "Post or comment not found" });
      }
      if (post.type !== "question") {
        await session.abortTransaction();
        return res
          .status(400)
          .json({ message: "Accepted answers are only for questions" });
      }
      if (post.author.toString() !== userId) {
        await session.abortTransaction();
        return res
          .status(403)
          .json({ message: "Only question author can accept answers" });
      }

      const previouslyAcceptedId = post.acceptedComment
        ? post.acceptedComment.toString()
        : null;

      // Toggle off when selecting the currently accepted comment
      if (previouslyAcceptedId === commentId) {
        await Comment.findByIdAndUpdate(commentId, {
          isAccepted: false,
        }).session(session);
        await Post.findByIdAndUpdate(postId, {
          acceptedComment: null,
          status: "open",
        }).session(session);
        await User.findByIdAndUpdate(comment.author, [
          {
            $set: {
              reputation: {
                $max: [
                  0,
                  {
                    $subtract: ["$reputation", FEED_REPUTATION.ACCEPTED_ANSWER],
                  },
                ],
              },
            },
          },
        ]).session(session);

        await session.commitTransaction();
        getIo(req).to(`feed:post:${postId}`).emit("feed:answer:accepted", {
          postId,
          commentId: null,
          resolved: false,
        });
        emitReputationUpdated(getIo(req), comment.author);
        return res.json({ acceptedComment: null, status: "open" });
      }

      // Clear previous accepted answer if exists
      if (previouslyAcceptedId) {
        const previousComment = await Comment.findByIdAndUpdate(
          previouslyAcceptedId,
          { isAccepted: false },
          { new: true },
        ).session(session);
        if (previousComment) {
          await User.findByIdAndUpdate(previousComment.author, [
            {
              $set: {
                reputation: {
                  $max: [
                    0,
                    {
                      $subtract: [
                        "$reputation",
                        FEED_REPUTATION.ACCEPTED_ANSWER,
                      ],
                    },
                  ],
                },
              },
            },
          ]).session(session);
        }
      }

      // Set new accepted answer
      await Comment.findByIdAndUpdate(commentId, { isAccepted: true }).session(
        session,
      );
      await Post.findByIdAndUpdate(postId, {
        acceptedComment: commentId,
        status: "resolved",
      }).session(session);
      await User.findByIdAndUpdate(comment.author, [
        {
          $set: {
            reputation: {
              $add: ["$reputation", FEED_REPUTATION.ACCEPTED_ANSWER],
            },
          },
        },
      ]).session(session);

      await session.commitTransaction();

      getIo(req).to(`feed:post:${postId}`).emit("feed:answer:accepted", {
        postId,
        commentId,
        resolved: true,
      });
      emitReputationUpdated(getIo(req), comment.author);

      // ── Notification ─────────────────────────────────────────────
      if (comment.author.toString() !== userId) {
        const { emitToUser } = createHelpers(getIo(req));
        await NotificationService.push(emitToUser, {
          recipientId: comment.author.toString(),
          type: "feed_answer_accepted",
          actorId: userId,
          data: { postId, postTitle: "your answer" },
        });
      }

      return res.json({ acceptedComment: commentId, status: "resolved" });
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } catch (err) {
    console.error("toggleAcceptedAnswer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/posts/:id/poll-vote
// Toggle vote for a poll option.
// ---------------------------------------------------------------------------
exports.votePoll = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { optionIndex } = req.body;

    // Check post access (privacy/ownership)
    const access = await checkPostAccess(id, userId);
    if (access.error) {
      return res
        .status(access.error.status)
        .json({ message: access.error.message });
    }
    const post = access.post;
    // Reload post with poll data
    const fullPost = await Post.findById(id);
    if (!fullPost || fullPost.type !== "poll") {
      return res.status(404).json({ message: "Poll not found" });
    }
    Object.assign(post, fullPost.toObject());

    if (!Number.isInteger(optionIndex)) {
      return res
        .status(400)
        .json({ message: "optionIndex must be an integer" });
    }
    if (optionIndex < 0 || optionIndex >= post.poll.options.length) {
      return res.status(400).json({ message: "Invalid poll option" });
    }

    if (post.poll.endsAt && new Date(post.poll.endsAt) < new Date()) {
      return res.status(400).json({ message: "Poll has expired" });
    }

    const uid = userId.toString();
    const options = post.poll.options;

    if (!post.poll.multiSelect) {
      for (let i = 0; i < options.length; i += 1) {
        options[i].votes = options[i].votes.filter((v) => v.toString() !== uid);
      }
    }

    const targetVotes = options[optionIndex].votes;
    const hasVoted = targetVotes.some((v) => v.toString() === uid);
    if (hasVoted) {
      options[optionIndex].votes = targetVotes.filter(
        (v) => v.toString() !== uid,
      );
    } else {
      options[optionIndex].votes.push(userId);
    }

    await post.save();

    getIo(req).to(`feed:post:${id}`).emit("feed:poll:voted", {
      postId: id,
      poll: post.poll,
    });

    return res.json({ poll: post.poll });
  } catch (err) {
    console.error("votePoll error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /api/feed/tags/:tag/follow
// Toggle follow/unfollow a tag.
// ---------------------------------------------------------------------------
exports.followTag = async (req, res) => {
  try {
    const userId = req.user.id;
    const rawTag = String(req.params.tag || "")
      .trim()
      .toLowerCase();
    if (!rawTag) return res.status(400).json({ message: "Tag is required" });

    const me = await User.findById(userId).select("followedTags");
    if (!me) return res.status(404).json({ message: "User not found" });

    const already = me.followedTags.includes(rawTag);

    const update = already
      ? { $pull: { followedTags: rawTag } }
      : { $addToSet: { followedTags: rawTag } };

    await User.findByIdAndUpdate(userId, update);

    getIo(req).to(`feed:user:${userId}`).emit("feed:tag:followed", {
      userId,
      tag: rawTag,
      following: !already,
    });

    return res.json({ tag: rawTag, following: !already });
  } catch (err) {
    console.error("followTag error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/tags/trending
// ---------------------------------------------------------------------------
exports.getTrendingTags = async (req, res) => {
  try {
    const days = clampInt(req.query.days, 30, 1, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const tags = await Post.aggregate([
      {
        $match: {
          isPrivate: false,
          createdAt: { $gte: since },
          tags: { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$tags" },
      {
        $group: {
          _id: "$tags",
          posts: { $sum: 1 },
          reactions: { $sum: "$reactionCount" },
          comments: { $sum: "$commentsCount" },
        },
      },
      {
        $addFields: {
          score: {
            $add: ["$posts", { $multiply: ["$reactions", 2] }, "$comments"],
          },
        },
      },
      { $sort: { score: -1, posts: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          tag: "$_id",
          posts: 1,
          reactions: 1,
          comments: 1,
          score: 1,
        },
      },
    ]);

    return res.json(tags);
  } catch (err) {
    console.error("getTrendingTags error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/feed/search
// Full-text post search with filters.
// ---------------------------------------------------------------------------
exports.searchFeed = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const skip = (page - 1) * limit;

    const q = req.query.q ? String(req.query.q).trim() : "";
    const type = req.query.type ? String(req.query.type).toLowerCase() : "all";
    const tags = normalizeTags(req.query.tags);
    const sort = req.query.sort
      ? String(req.query.sort).toLowerCase()
      : "latest";

    const filter = { $or: [{ isPrivate: false }, { author: userId }] };

    if (type !== "all" && VALID_TYPES.includes(type)) {
      filter.type = type;
    }
    if (tags.length) {
      filter.tags = { $in: tags };
    }
    if (q) {
      // Split into words and match each word as a prefix (word-by-word partial match)
      const words = q.trim().split(/\s+/).filter(Boolean);
      const wordConditions = words.map((word) => {
        const regex = new RegExp(word, "i");
        return {
          $or: [
            { title: { $regex: regex } },
            { content: { $regex: regex } },
            { tags: { $regex: regex } },
          ],
        };
      });
      // All words must match (AND logic)
      if (wordConditions.length === 1) {
        Object.assign(filter, wordConditions[0]);
      } else {
        filter.$and = wordConditions;
      }
    }

    const projection = null;
    const sortPreset = SORT_PRESETS[sort] || SORT_PRESETS.latest;
    const sorting = sortPreset;

    const [posts, total] = await Promise.all([
      Post.find(filter, projection)
        .populate("author", "name avatar reputation")
        .sort(sorting)
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    return res.json({
      posts,
      total,
      page,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error("searchFeed error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};
