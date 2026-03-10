const mongoose = require("mongoose");

const moduleMessageSchema = new mongoose.Schema(
    {
        moduleId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Module",
            required: true,
        },

        workspaceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
        },

        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        text: {
            type: String,
            trim: true,
            default: null,
        },

        gifUrl: {
            type: String,
            default: null,
        },

        // Thread reply support
        replyTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ModuleMessage",
            default: null,
        },

        // Emoji reactions - Map of emoji -> array of userIds
        reactions: {
            type: Map,
            of: [mongoose.Schema.Types.ObjectId],
            default: {},
        },

        // Read tracking - who has read this message
        readBy: [
            {
                user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
                readAt: { type: Date },
            },
        ],

        // Edit tracking
        isEdited: {
            type: Boolean,
            default: false,
        },

        editedAt: {
            type: Date,
            default: null,
        },

        // Deletion tracking
        isDeleted: {
            type: Boolean,
            default: false,
        },

        // Users who deleted this message for themselves only
        deletedFor: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],
    },
    { timestamps: true }
);

// Index for efficient message queries
moduleMessageSchema.index({ moduleId: 1, createdAt: -1 });
moduleMessageSchema.index({ workspaceId: 1 });

module.exports = mongoose.model("ModuleMessage", moduleMessageSchema);
