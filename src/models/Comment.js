const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
    {
        post: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Post",
            required: true,
            index: true,
        },
        author: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        parentComment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Comment",
            default: null,
            index: true,
        },
        content: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 5000,
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
        isAccepted: {
            type: Boolean,
            default: false,
            index: true,
        },
    },
    { timestamps: true },
);

commentSchema.index({ post: 1, parentComment: 1, createdAt: 1 });
commentSchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model("Comment", commentSchema);
