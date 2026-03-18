const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Populated for DMs; null for group messages
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },

    // ── Group-only delivery / read tracking ───────────────────────
    // Each entry records when a specific participant received the message
    deliveredTo: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        deliveredAt: { type: Date },
      },
    ],

    // Each entry records when a specific participant read the message
    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        readAt: { type: Date },
      },
    ],
    // ──────────────────────────────────────────────────────────────

    text: {
      type: String,
      required: false,
      trim: true,
      default: "",
    },

    gifUrl: {
      type: String,
      default: null,
    },

    //  NEW: Thread Reply Field
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    //  NEW: Thread Metadata
    replyCount: {
      type: Number,
      default: 0,
    },
    lastReplyAt: {
      type: Date,
      default: null,
    },
    //  NEW: Attachments
    attachments: [
      {
        url: { type: String, required: true },
        publicId: { type: String }, // For Cloudinary/S3 deletion
        resourceType: { type: String }, // image, video, raw, audio
        format: { type: String },
        name: { type: String },
        size: { type: Number },
      },
    ],
    // Scheduled Messages
    scheduledFromId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScheduledMessage",
      default: null,
    },

    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    seenAt: {
      type: Date,
      default: null,
    },

    // ADD BELOW status fields

    isEdited: {
      type: Boolean,
      default: false,
    },

    editedAt: {
      type: Date,
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    reactions: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: {},
    },
    // ────────────────────────────────────────────────────────
    // ✅ NEW: Poll Data
    // ────────────────────────────────────────────────────────
    poll: {
      question: {
        type: String,
        trim: true,
        maxlength: 500,
      },
      options: [
        {
          id: {
            type: String,
            required: true,
          },
          text: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
          },
          votes: [
            {
              type: mongoose.Schema.Types.ObjectId,
              ref: "User",
            },
          ],
        },
      ],
      allowMultiple: {
        type: Boolean,
        default: false,
      },
      expiresAt: {
        type: Date,
      },
      createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: function () {
          return !!this.poll && !!this.poll.question; // ✅ Only required if poll exists
        },
      },
    },
  },
  { timestamps: true },
);

// Fast paginated history queries: fetch messages for a conversation sorted by time
messageSchema.index({ conversationId: 1, createdAt: -1 });

// sender fast load
messageSchema.index({ sender: 1, createdAt: -1 });

// Delete for Me query fast
messageSchema.index({ deletedFor: 1 });

// Index for bulk updates: find all messages for a conversation up to a specific message
messageSchema.index({ conversationId: 1, _id: 1 });

// DM-only: find undelivered or unseen messages by receiver — partial index skips group messages
messageSchema.index(
  { receiverId: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { receiverId: { $ne: null } } },
);

// Group-only: efficiently query which participants have read a message
messageSchema.index({ conversationId: 1, "readBy.user": 1 });

// Reply index
messageSchema.index({ replyTo: 1 });

// Scheduled Messages
messageSchema.index({ scheduledFromId: 1 }, { unique: true, sparse: true });


// ──────────────────────────────────────────────────────────
// Get total votes
// ──────────────────────────────────────────────────────────
messageSchema.methods.getTotalVotes = function () {
  if (!this.poll || !Array.isArray(this.poll.options)) {
    return 0;
  }

  return this.poll.options.reduce((total, opt) => {
    return total + (Array.isArray(opt.votes) ? opt.votes.length : 0);
  }, 0);
};

// ──────────────────────────────────────────────────────────
// Check if poll expired
// ──────────────────────────────────────────────────────────
messageSchema.methods.isPollExpired = function () {
  if (!this.poll || !this.poll.expiresAt) {
    return false;
  }

  return new Date() > new Date(this.poll.expiresAt);
};

// ──────────────────────────────────────────────────────────
// Get poll results
// ──────────────────────────────────────────────────────────
messageSchema.methods.getPollResults = function () {
  if (!this.poll || !Array.isArray(this.poll.options)) {
    return [];
  }

  const totalVotes = this.getTotalVotes();

  return this.poll.options.map((opt) => {
    const voteCount = Array.isArray(opt.votes) ? opt.votes.length : 0;

    return {
      id: opt.id,
      text: opt.text,
      votes: voteCount,
      percentage: totalVotes > 0
        ? Math.round((voteCount / totalVotes) * 100)
        : 0,
    };
  });
};

module.exports = mongoose.model("Message", messageSchema);
