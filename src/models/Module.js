const mongoose = require("mongoose");

const moduleSchema = new mongoose.Schema(
    {
        workspaceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
        },

        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
        },

        description: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },

        type: {
            type: String,
            enum: ["chat", "announcement"],
            default: "chat",
        },

        // Private modules - only visible to specified members
        isPrivate: {
            type: Boolean,
            default: false,
        },

        // For private modules - array of allowed member IDs
        // Admins/owners always have access
        allowedMembers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
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

        // Unread count per workspace member
        unreadCount: {
            type: Map,
            of: Number,
            default: {},
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
    },
    { timestamps: true }
);

// Compound index for workspace queries
moduleSchema.index({ workspaceId: 1, isPrivate: 1 });

module.exports = mongoose.model("Module", moduleSchema);
