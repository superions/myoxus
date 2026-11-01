/**
 * @file constant.ts — @myoxus/env
 *
 * Shared application-level constants and error types used by both
 * `client/admin` and `client/web`.
 *
 * This file must remain side-effect-free (no module-level code with
 * observable behaviour) so it can be safely tree-shaken.
 */

// This file should has not side effect

/** Default name shown for a brand-new demo workspace. */
export const DEFAULT_WORKSPACE_NAME = "Demo Workspace";
/** Placeholder name shown for a workspace that has not been named yet. */
export const UNTITLED_WORKSPACE_NAME = "Untitled";

/** Default sort field for workspace / document list views. */
export const DEFAULT_SORT_KEY = "updatedDate";

/**
 * Numeric codes for user-facing error conditions.
 *
 * These are legacy codes used in the `Messages` map and in legacy error
 * handling paths.  New code should prefer {@link UserFriendlyError} from
 * `@myoxus/error`.
 */
export const MessageCode = {
  loginError: 0,
  noPermission: 1,
  loadListFailed: 2,
  getDetailFailed: 3,
  createWorkspaceFailed: 4,
  getMembersFailed: 5,
  updateWorkspaceFailed: 6,
  deleteWorkspaceFailed: 7,
  inviteMemberFailed: 8,
  removeMemberFailed: 9,
  acceptInvitingFailed: 10,
  getBlobFailed: 11,
  leaveWorkspaceFailed: 12,
  downloadWorkspaceFailed: 13,
  refreshTokenError: 14,
  blobTooLarge: 15,
} as const;

export const Messages = {
  [MessageCode.loginError]: {
    message: "Login failed",
  },
  [MessageCode.noPermission]: {
    message: "No permission",
  },
  [MessageCode.loadListFailed]: {
    message: "Load list failed",
  },
  [MessageCode.getDetailFailed]: {
    message: "Get detail failed",
  },
  [MessageCode.createWorkspaceFailed]: {
    message: "Create workspace failed",
  },
  [MessageCode.getMembersFailed]: {
    message: "Get members failed",
  },
  [MessageCode.updateWorkspaceFailed]: {
    message: "Update workspace failed",
  },
  [MessageCode.deleteWorkspaceFailed]: {
    message: "Delete workspace failed",
  },
  [MessageCode.inviteMemberFailed]: {
    message: "Invite member failed",
  },
  [MessageCode.removeMemberFailed]: {
    message: "Remove member failed",
  },
  [MessageCode.acceptInvitingFailed]: {
    message: "Accept inviting failed",
  },
  [MessageCode.getBlobFailed]: {
    message: "Get blob failed",
  },
  [MessageCode.leaveWorkspaceFailed]: {
    message: "Leave workspace failed",
  },
  [MessageCode.downloadWorkspaceFailed]: {
    message: "Download workspace failed",
  },
  [MessageCode.refreshTokenError]: {
    message: "Refresh token failed",
  },
  [MessageCode.blobTooLarge]: {
    message: "Blob too large",
  },
} as const satisfies {
  [key in (typeof MessageCode)[keyof typeof MessageCode]]: {
    message: string;
  };
};

/**
 * Thrown when a workspace with the given ID cannot be located.
 *
 * Extend `TypeError` so that callers can distinguish it from generic
 * `Error` in catch blocks.
 */
export class WorkspaceNotFoundError extends TypeError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super();
    this.workspaceId = workspaceId;
  }
}

/**
 * Thrown when a required URL query parameter is missing or has an unexpected value.
 *
 * @param targetKey - The expected query parameter key.
 * @param query     - The raw query object that was inspected.
 */
export class QueryParamError extends TypeError {
  readonly targetKey: string;
  readonly query: unknown;

  constructor(targetKey: string, query: unknown) {
    super();
    this.targetKey = targetKey;
    this.query = query;
  }
}

/**
 * Thrown to mark code branches that should be statically unreachable.
 *
 * Useful as the default case in exhaustive `switch` statements to catch
 * unhandled enum values at runtime.
 */
export class Unreachable extends Error {
  constructor(message?: string) {
    super(message);
  }
}
