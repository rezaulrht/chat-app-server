const mongoose = require("mongoose");

const scheduledMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Module",
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    sendAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "sending", "sent", "failed", "cancelled"],
      default: "scheduled",
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: String,
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ScheduledMessage", scheduledMessageSchema);
