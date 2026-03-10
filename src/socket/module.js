/**
 * Module socket handlers
 *
 * Export: registerModuleHandlers(socket, { emitToUser, io })
 *
 * Handles inbound events:
 *   module:message:send
 *   module:message:react
 *   module:message:edit
 *   module:message:delete
 *   module:seen
 *   module:typing:start
 *   module:typing:stop
 *   module:join    — manual room subscription
 *   module:leave   — manual room unsubscription
 */

const Workspace = require("../models/Workspace");
const Module = require("../models/Module");
const ModuleMessage = require("../models/ModuleMessage");

// Reuse same constants as typing.js
const TYPING_AUTO_STOP_MS = 5000;
const TYPING_THROTTLE_MS = 500;

// Module-level maps — persist across connections in this process
// Key: "moduleId:userId"
const moduleTypingTimers = new Map();

const registerModuleHandlers = (socket, { emitToUser, io }) => {
    // Per-socket throttle: moduleId → last accepted typing:start timestamp
    const lastModuleTypingEmit = new Map();

    // ================================================================
    // module:join / module:leave
    // ================================================================

    socket.on("module:join", async (moduleId) => {
        if (!moduleId) return;
        try {
            // Verify module exists and user is a workspace member
            const mod = await Module.findById(moduleId).select(
                "workspaceId isPrivate allowedMembers"
            );
            if (!mod) return;

            const workspace = await Workspace.findOne({
                _id: mod.workspaceId,
                "members.user": socket.userId,
            }).select("_id members");
            if (!workspace) return;

            // Private module check
            if (mod.isPrivate) {
                const memberRecord = workspace.members.find(
                    (m) => m.user.toString() === socket.userId
                );
                const isAdmin =
                    memberRecord?.role === "owner" || memberRecord?.role === "admin";
                const isAllowed = mod.allowedMembers
                    .map(String)
                    .includes(socket.userId);
                if (!isAdmin && !isAllowed) return;
            }

            socket.join(`module:${moduleId}`);
        } catch (err) {
            console.error("module:join error:", err.message);
        }
    });

    socket.on("module:leave", (moduleId) => {
        if (moduleId) socket.leave(`module:${moduleId}`);
    });



    // Cleanup function for disconnect
    const cleanup = () => {
        // Clear all module typing timers this socket set
        for (const [key, timer] of moduleTypingTimers.entries()) {
            if (key.endsWith(`:${socket.userId}`)) {
                clearTimeout(timer);
                moduleTypingTimers.delete(key);
            }
        }
    };

    return { cleanup };
};

module.exports = registerModuleHandlers;
