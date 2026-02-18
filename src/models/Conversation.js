const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    lastMessage: {
      text: {
        type: String,
        default: "",
      },
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      timestamp: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true },
);

// Fast lookup: find all conversations a user is part of
conversationSchema.index({ participants: 1 });

// Prevent duplicate conversations between the same two users
conversationSchema.index({ participants: 1, _id: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
