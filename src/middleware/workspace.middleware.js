/**
 * Workspace permission middleware
 *
 * Chain these on workspace routes in order:
 *   validateWorkspaceId → loadWorkspace → isWorkspaceMember → isWorkspaceAdmin | isWorkspaceOwner
 *
 * Each middleware attaches to req so downstream controllers
 * never need to re-query the database.
 *
 *   req.workspace     — the full Workspace document (set by loadWorkspace)
 *   req.memberRecord  — the caller's member subdocument, including role (set by isWorkspaceMember)
 */

const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");

// ---------------------------------------------------------------------------
// validateWorkspaceId
// Sync guard — rejects garbage IDs before any DB call is made.
// Put this first in every route chain that uses :workspaceId.
// ---------------------------------------------------------------------------
exports.validateWorkspaceId = (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.workspaceId)) {
    return res.status(400).json({ message: "Invalid workspace ID" });
  }
  next();
};

// ---------------------------------------------------------------------------
// loadWorkspace
// Fetches the workspace by req.params.workspaceId and attaches it to req.workspace.
// Requires validateWorkspaceId to have run first.
// ---------------------------------------------------------------------------
exports.loadWorkspace = async (req, res, next) => {
  try {
    const workspace = await Workspace.findById(req.params.workspaceId);
    if (!workspace) {
      return res.status(404).json({ message: "Workspace not found" });
    }
    req.workspace = workspace;
    next();
  } catch (err) {
    console.error("loadWorkspace error:", err.message);
    res.status(400).json({ message: "Invalid workspace ID" });
  }
};

// ---------------------------------------------------------------------------
// isWorkspaceMember
// Ensures the authenticated user is a member of the workspace.
// Also attaches req.memberRecord (the full subdocument including role) so that
// isWorkspaceAdmin and isWorkspaceOwner never need to search the array again.
// Requires loadWorkspace to have run first.
// ---------------------------------------------------------------------------
exports.isWorkspaceMember = (req, res, next) => {
  const userId = req.user.id;
  const memberRecord = req.workspace.members.find(
    (m) => m.user.toString() === userId,
  );
  if (!memberRecord) {
    return res
      .status(403)
      .json({ message: "You are not a member of this workspace" });
  }
  req.memberRecord = memberRecord;
  next();
};

// ---------------------------------------------------------------------------
// isWorkspaceAdmin
// Ensures the authenticated user has ADMINISTRATOR or MANAGE_WORKSPACE permission.
// Requires isWorkspaceMember to have run first (reads req.memberRecord).
// ---------------------------------------------------------------------------
exports.isWorkspaceAdmin = (req, res, next) => {
  const { role, roleIds } = req.memberRecord;
  const { PERMISSIONS } = Workspace;

  if (role === "owner" || role === "admin") {
    return next();
  }

  // Check custom roles for ADMINISTRATOR or MANAGE_WORKSPACE
  let hasAdminPerms = false;
  if (roleIds && roleIds.length > 0 && req.workspace.roles) {
    const roleIdsStr = roleIds.map(String);
    const userRoles = req.workspace.roles.filter((r) => roleIdsStr.includes(r._id.toString()));
    
    for (const r of userRoles) {
      if (
        r.permissions?.includes(PERMISSIONS.ADMINISTRATOR) || 
        r.permissions?.includes(PERMISSIONS.MANAGE_WORKSPACE)
      ) {
        hasAdminPerms = true;
        break;
      }
    }
  }

  if (!hasAdminPerms) {
    return res
      .status(403)
      .json({ message: "Only workspace admins can perform this action" });
  }

  next();
};

// ---------------------------------------------------------------------------
// isWorkspaceOwner
// Ensures the authenticated user is the owner of the workspace.
// Requires isWorkspaceMember to have run first (reads req.memberRecord.role).
// ---------------------------------------------------------------------------
exports.isWorkspaceOwner = (req, res, next) => {
  if (req.memberRecord.role !== "owner") {
    return res
      .status(403)
      .json({ message: "Only the workspace owner can perform this action" });
  }
  next();
};
