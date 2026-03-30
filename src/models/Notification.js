const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "chat_message",
        "chat_mention",
        "call_missed",
        "feed_reaction",
        "feed_comment",
        "feed_follow",
        "feed_answer_accepted",
        "workspace_mention",
      ],
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
    actors: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    actorCount: {
      type: Number,
      default: 1,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, read: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
