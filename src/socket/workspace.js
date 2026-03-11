/**
 * Workspace socket handlers
 *
 * Export: registerWorkspaceHandlers(socket, { emitToUser, io })
 *
 * Handles:
 *   workspace:join  — manual room subscription (called by client on workspace open)
 *   workspace:leave — manual room unsubscription
 *
 * Outbound events emitted by controllers (not this file):
 *   workspace:created, workspace:updated, workspace:deleted,
 *   workspace:member-joined, workspace:member-left,
 *   workspace:kicked, workspace:owner-transferred, workspace:role-updated
 *
 * This file handles the INBOUND socket events from clients +
 * the connect-time auto-join into workspace rooms.
 */

const Workspace = require("../models/Workspace");
const mongoose = require("mongoose");

const registerWorkspaceHandlers = (socket, { emitToUser, io }) => {
    // ----------------------------------------------------------------
    // workspace:join
    // Client emits when opening the workspace view.
    // Joins the socket into workspace:<workspaceId> room.
    // Security: verify user is actually a member before joining.
    // ----------------------------------------------------------------
    socket.on("workspace:join", async (workspaceId) => {
        if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) return;
        try {
            const workspace = await Workspace.findOne({
                _id: workspaceId,
                "members.user": socket.userId,
            }).select("_id");
            if (!workspace) return; // silently ignore — not a member
            socket.join(`workspace:${workspaceId}`);
        } catch (err) {
            console.error("workspace:join error:", err.message);
        }
    });

    // ----------------------------------------------------------------
    // workspace:leave
    // Client emits when navigating away from a workspace view.
    // ----------------------------------------------------------------
    socket.on("workspace:leave", (workspaceId) => {
        if (workspaceId) socket.leave(`workspace:${workspaceId}`);
    });
};

module.exports = registerWorkspaceHandlers;

// Kept for future controller-driven socket emits outside this handler module.
// Optional wrappers for controller-side emits
const emitWorkspaceUpdated = (io, workspaceId, data) => {
    io.to(`workspace:${workspaceId}`).emit("workspace:updated", data);
};

const emitWorkspaceDeleted = (io, workspaceId, data) => {
    io.to(`workspace:${workspaceId}`).emit("workspace:deleted", data);
};

const emitWorkspaceMemberJoined = (io, workspaceId, data) => {
    io.to(`workspace:${workspaceId}`).emit("workspace:member-joined", data);
};

const emitWorkspaceMemberLeft = (io, workspaceId, data) => {
    io.to(`workspace:${workspaceId}`).emit("workspace:member-left", data);
};

const emitWorkspaceRoleUpdated = (io, workspaceId, data) => {
    io.to(`workspace:${workspaceId}`).emit("workspace:role-updated", data);
};

module.exports.emitWorkspaceUpdated = emitWorkspaceUpdated;
module.exports.emitWorkspaceDeleted = emitWorkspaceDeleted;
module.exports.emitWorkspaceMemberJoined = emitWorkspaceMemberJoined;
module.exports.emitWorkspaceMemberLeft = emitWorkspaceMemberLeft;
module.exports.emitWorkspaceRoleUpdated = emitWorkspaceRoleUpdated;
