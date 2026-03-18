const mongoose = require("mongoose");

const codeBlockSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      trim: true,
      maxlength: 180,
      default: "snippet.txt",
    },
    language: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "text",
    },
    code: {
      type: String,
      trim: true,
      maxlength: 50000,
      default: "",
    },
  },
  { _id: false },
);

const linkPreviewSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      trim: true,
      maxlength: 2048,
      default: null,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 240,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 600,
      default: null,
    },
    image: {
      type: String,
      trim: true,
      maxlength: 2048,
      default: null,
    },
  },
  { _id: false },
);

const pollOptionSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      trim: true,
      maxlength: 200,
      required: true,
    },
    votes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { _id: false },
);

const pollSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      trim: true,
      maxlength: 280,
      default: null,
    },
    options: {
      type: [pollOptionSchema],
      default: [],
    },
    multiSelect: {
      type: Boolean,
      default: false,
    },
    duration: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "7 Days",
    },
    endsAt: {
      type: Date,
      default: null,
    },
    visibility: {
      type: String,
      trim: true,
      maxlength: 30,
      default: "Public",
    },
  },
  { _id: false },
);

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["post", "question", "til", "snippet", "showcase", "poll", "resource"],
      required: true,
      index: true,
    },

    title: {
      type: String,
      trim: true,
      maxlength: 240,
      default: null,
    },

    content: {
      type: String,
      trim: true,
      maxlength: 50000,
      default: "",
    },

    tags: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          maxlength: 40,
        },
      ],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length <= 5,
        message: "A post can have at most 5 tags",
      },
      index: true,
    },

    isPrivate: {
      type: Boolean,
      default: false,
      index: true,
    },

    isPinned: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
      index: true,
    },

    codeBlocks: {
      type: [codeBlockSchema],
      default: [],
    },

    linkPreview: {
      type: linkPreviewSchema,
      default: () => ({
        url: null,
        title: null,
        description: null,
        image: null,
      }),
    },

    screenshots: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 2048,
        },
      ],
      default: [],
    },

    resourceCategory: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },

    poll: {
      type: pollSchema,
      default: () => ({
        question: null,
        options: [],
        multiSelect: false,
        duration: "7 Days",
        endsAt: null,
        visibility: "Public",
      }),
    },

    reactions: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: {},
    },

    reactionCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    bonus5Reactions: {
      type: Boolean,
      default: false,
    },

    commentsCount: {
      type: Number,
      min: 0,
      default: 0,
    },

    acceptedComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
    },

    questionBonusAwarded: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

postSchema.pre("validate", function () {
  const requiresTitle = ["post", "question", "snippet", "showcase", "resource"];

  if (requiresTitle.includes(this.type) && (!this.title || !this.title.trim())) {
    throw new Error("Title is required for this post type");
  }

  if (["post", "question", "til"].includes(this.type) && (!this.content || !this.content.trim())) {
    throw new Error("Content is required for this post type");
  }

  if (this.type === "snippet") {
    if (!Array.isArray(this.codeBlocks) || this.codeBlocks.length === 0) {
      throw new Error("Snippet posts require at least one code block");
    }

    const hasEmptyCode = this.codeBlocks.some((item) => !item.code || !item.code.trim());
    if (hasEmptyCode) {
      throw new Error("Snippet code block cannot be empty");
    }
  }

  if (this.type === "poll") {
    const options = this.poll?.options ?? [];

    if (!this.poll?.question || !this.poll.question.trim()) {
      throw new Error("Poll question is required");
    }

    if (options.length < 2 || options.length > 6) {
      throw new Error("Poll must include between 2 and 6 options");
    }

    const invalidOption = options.some((option) => !option.text || !option.text.trim());
    if (invalidOption) {
      throw new Error("Poll options cannot be empty");
    }
  }

  if (this.type === "showcase") {
    if (!this.linkPreview?.url || !this.linkPreview.url.trim()) {
      throw new Error("Showcase posts require a project URL");
    }
  }

  if (this.type === "resource") {
    if (!this.linkPreview?.url || !this.linkPreview.url.trim()) {
      throw new Error("Resource posts require a URL");
    }
  }
});

postSchema.index({ createdAt: -1 });
postSchema.index({ type: 1, createdAt: -1 });
postSchema.index({ isPrivate: 1, createdAt: -1 });
postSchema.index({ reactionCount: -1, createdAt: -1 });
postSchema.index({ title: "text", content: "text", tags: "text" });
// Partial index on acceptedComment to exclude nulls
postSchema.index({ acceptedComment: 1 }, { partialFilterExpression: { acceptedComment: { $ne: null } } });

module.exports = mongoose.model("Post", postSchema);