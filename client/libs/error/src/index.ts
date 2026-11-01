/**
 * @file index.ts — @myoxus/error
 *
 * Unified error types for the Myoxus frontend.
 *
 * - {@link GraphQLError}      — extends the standard `graphql` GraphQLError with
 *                               normalized `extensions` carrying the server's
 *                               {@link UserFriendlyErrorResponse} payload.
 * - {@link UserFriendlyError} — the primary error class used throughout the UI;
 *                               wraps both server errors and network errors into a
 *                               consistent shape.
 *
 * Typical usage:
 * ```ts
 * try { await gql(...) } catch (e) {
 *   const err = UserFriendlyError.fromAny(e);
 *   if (err.is('NOT_FOUND')) { ... }
 *   if (err.isNetworkError()) { ... }
 * }
 * ```
 *
 * Consumers: all packages in `client/libs`, `client/admin`, `client/web`.
 */

import { GraphQLError as BaseGraphQLError } from "graphql";

/**
 * Server error names mirrored from the generated GraphQL schema.
 *
 * `@myoxus/error` must stay below `@myoxus/graphql` in the dependency graph,
 * so this union is intentionally kept as a type-only mirror instead of importing
 * the generated enum and recreating the workspace cycle.
 */
export type ServerErrorName =
  | "ACCESS_DENIED"
  | "ACTION_FORBIDDEN"
  | "ALREADY_IN_SPACE"
  | "AUTHENTICATION_REQUIRED"
  | "BAD_REQUEST"
  | "BLOB_INVALID"
  | "BLOB_NOT_FOUND"
  | "BLOB_QUOTA_EXCEEDED"
  | "CALENDAR_PROVIDER_REQUEST_ERROR"
  | "CANNOT_DELETE_ALL_ADMIN_ACCOUNT"
  | "CANNOT_DELETE_OWN_ACCOUNT"
  | "CANT_UPDATE_ONETIME_PAYMENT_SUBSCRIPTION"
  | "CAN_NOT_BATCH_GRANT_DOC_OWNER_PERMISSIONS"
  | "CAN_NOT_REVOKE_YOURSELF"
  | "CAPTCHA_VERIFICATION_FAILED"
  | "COMMENT_ATTACHMENT_NOT_FOUND"
  | "COMMENT_ATTACHMENT_QUOTA_EXCEEDED"
  | "COMMENT_NOT_FOUND"
  | "COPILOT_ACTION_TAKEN"
  | "COPILOT_CONTEXT_FILE_NOT_SUPPORTED"
  | "COPILOT_DOCS_NOT_FOUND"
  | "COPILOT_DOC_NOT_FOUND"
  | "COPILOT_EMBEDDING_DISABLED"
  | "COPILOT_EMBEDDING_UNAVAILABLE"
  | "COPILOT_FAILED_TO_ADD_WORKSPACE_FILE_EMBEDDING"
  | "COPILOT_FAILED_TO_CREATE_MESSAGE"
  | "COPILOT_FAILED_TO_GENERATE_EMBEDDING"
  | "COPILOT_FAILED_TO_GENERATE_TEXT"
  | "COPILOT_FAILED_TO_MATCH_CONTEXT"
  | "COPILOT_FAILED_TO_MATCH_GLOBAL_CONTEXT"
  | "COPILOT_FAILED_TO_MODIFY_CONTEXT"
  | "COPILOT_INVALID_CONTEXT"
  | "COPILOT_MESSAGE_NOT_FOUND"
  | "COPILOT_PROMPT_INVALID"
  | "COPILOT_PROMPT_NOT_FOUND"
  | "COPILOT_PROVIDER_NOT_SUPPORTED"
  | "COPILOT_PROVIDER_SIDE_ERROR"
  | "COPILOT_QUOTA_EXCEEDED"
  | "COPILOT_SESSION_DELETED"
  | "COPILOT_SESSION_INVALID_INPUT"
  | "COPILOT_SESSION_NOT_FOUND"
  | "COPILOT_TRANSCRIPTION_AUDIO_NOT_PROVIDED"
  | "COPILOT_TRANSCRIPTION_JOB_EXISTS"
  | "COPILOT_TRANSCRIPTION_JOB_NOT_FOUND"
  | "CUSTOMER_PORTAL_CREATE_FAILED"
  | "DOC_ACTION_DENIED"
  | "DOC_DEFAULT_ROLE_CAN_NOT_BE_OWNER"
  | "DOC_HISTORY_NOT_FOUND"
  | "DOC_IS_NOT_PUBLIC"
  | "DOC_NOT_FOUND"
  | "DOC_UPDATE_BLOCKED"
  | "EMAIL_ALREADY_USED"
  | "EMAIL_SERVICE_NOT_CONFIGURED"
  | "EMAIL_TOKEN_NOT_FOUND"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "EXPECT_TO_GRANT_DOC_USER_ROLES"
  | "EXPECT_TO_PUBLISH_DOC"
  | "EXPECT_TO_REVOKE_DOC_USER_ROLES"
  | "EXPECT_TO_REVOKE_PUBLIC_DOC"
  | "EXPECT_TO_UPDATE_DOC_USER_ROLE"
  | "FAILED_TO_CHECKOUT"
  | "FAILED_TO_SAVE_UPDATES"
  | "FAILED_TO_UPSERT_SNAPSHOT"
  | "GRAPHQL_BAD_REQUEST"
  | "HTTP_REQUEST_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "INVALID_APP_CONFIG"
  | "INVALID_APP_CONFIG_INPUT"
  | "INVALID_AUTH_STATE"
  | "INVALID_CHECKOUT_PARAMETERS"
  | "INVALID_EMAIL"
  | "INVALID_EMAIL_TOKEN"
  | "INVALID_HISTORY_TIMESTAMP"
  | "INVALID_INDEXER_INPUT"
  | "INVALID_INVITATION"
  | "INVALID_LICENSE_SESSION_ID"
  | "INVALID_LICENSE_TO_ACTIVATE"
  | "INVALID_LICENSE_UPDATE_PARAMS"
  | "INVALID_OAUTH_CALLBACK_CODE"
  | "INVALID_OAUTH_CALLBACK_STATE"
  | "INVALID_OAUTH_RESPONSE"
  | "INVALID_PASSWORD_LENGTH"
  | "INVALID_RUNTIME_CONFIG_TYPE"
  | "INVALID_SEARCH_PROVIDER_REQUEST"
  | "INVALID_SUBSCRIPTION_PARAMETERS"
  | "LICENSE_EXPIRED"
  | "LICENSE_NOT_FOUND"
  | "LICENSE_REVEALED"
  | "LINK_EXPIRED"
  | "MAILER_SERVICE_IS_NOT_CONFIGURED"
  | "MANAGED_BY_APP_STORE_OR_PLAY"
  | "MEMBER_NOT_FOUND_IN_SPACE"
  | "MEMBER_QUOTA_EXCEEDED"
  | "MIX_DATABASE_BULK_CONFLICT"
  | "MIX_DATABASE_CELL_CONFLICT"
  | "MIX_DATABASE_FIELD_CONFLICT"
  | "MIX_DATABASE_ROW_CONFLICT"
  | "MIX_DATABASE_VIEW_CONFLICT"
  | "MENTION_USER_DOC_ACCESS_DENIED"
  | "MENTION_USER_ONESELF_DENIED"
  | "MISSING_OAUTH_QUERY_PARAMETER"
  | "NETWORK_ERROR"
  | "NEW_OWNER_IS_NOT_ACTIVE_MEMBER"
  | "NOTIFICATION_NOT_FOUND"
  | "NOT_FOUND"
  | "NOT_IN_SPACE"
  | "NO_COPILOT_PROVIDER_AVAILABLE"
  | "NO_MORE_SEAT"
  | "OAUTH_ACCOUNT_ALREADY_CONNECTED"
  | "OAUTH_STATE_EXPIRED"
  | "OWNER_CAN_NOT_LEAVE_WORKSPACE"
  | "PASSWORD_REQUIRED"
  | "QUERY_TOO_LONG"
  | "REPLY_NOT_FOUND"
  | "RESPONSE_TOO_LARGE_ERROR"
  | "RUNTIME_CONFIG_NOT_FOUND"
  | "SAME_EMAIL_PROVIDED"
  | "SAME_SUBSCRIPTION_RECURRING"
  | "SEARCH_PROVIDER_NOT_FOUND"
  | "SIGN_UP_FORBIDDEN"
  | "SPACE_ACCESS_DENIED"
  | "SPACE_NOT_FOUND"
  | "SPACE_OWNER_NOT_FOUND"
  | "SPACE_SHOULD_HAVE_ONLY_ONE_OWNER"
  | "SSRF_BLOCKED_ERROR"
  | "STORAGE_QUOTA_EXCEEDED"
  | "SUBSCRIPTION_ALREADY_EXISTS"
  | "SUBSCRIPTION_EXPIRED"
  | "SUBSCRIPTION_HAS_BEEN_CANCELED"
  | "SUBSCRIPTION_HAS_NOT_BEEN_CANCELED"
  | "SUBSCRIPTION_NOT_EXISTS"
  | "SUBSCRIPTION_PLAN_NOT_FOUND"
  | "TOO_MANY_REQUEST"
  | "UNKNOWN_OAUTH_PROVIDER"
  | "UNSPLASH_IS_NOT_CONFIGURED"
  | "UNSUPPORTED_CLIENT_VERSION"
  | "UNSUPPORTED_SUBSCRIPTION_PLAN"
  | "USER_AVATAR_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "VERSION_REJECTED"
  | "WORKSPACE_ID_REQUIRED_FOR_TEAM_SUBSCRIPTION"
  | "WORKSPACE_ID_REQUIRED_TO_UPDATE_TEAM_SUBSCRIPTION"
  | "WORKSPACE_LICENSE_ALREADY_EXISTS"
  | "WORKSPACE_PERMISSION_NOT_FOUND"
  | "WRONG_SIGN_IN_CREDENTIALS"
  | "WRONG_SIGN_IN_METHOD";

export type ErrorName =
  ServerErrorName | "CONTENT_TOO_LARGE" | "REQUEST_ABORTED";

/**
 * Stale-write errors resolved by the Database conflict UI instead of a generic
 * notification. Keeping the catalogue in the foundational error package lets
 * transport middleware classify the wire contract without depending on Core.
 */
export const DATABASE_CONFLICT_ERROR_NAMES = [
  "MIX_DATABASE_BULK_CONFLICT",
  "MIX_DATABASE_CELL_CONFLICT",
  "MIX_DATABASE_FIELD_CONFLICT",
  "MIX_DATABASE_ROW_CONFLICT",
  "MIX_DATABASE_VIEW_CONFLICT",
] as const satisfies readonly ErrorName[];

export type DatabaseConflictErrorName =
  (typeof DATABASE_CONFLICT_ERROR_NAMES)[number];

/** Return whether a server error name belongs to the stale-write family. */
export function isDatabaseConflictErrorName(
  name: string,
): name is DatabaseConflictErrorName {
  return DATABASE_CONFLICT_ERROR_NAMES.includes(
    name as DatabaseConflictErrorName,
  );
}

/**
 * The structured error payload returned by the Myoxus server.
 *
 * This mirrors the server's JSON error envelope and is embedded in
 * {@link GraphQLError.extensions} when the server responds with an error.
 */
export interface UserFriendlyErrorResponse {
  status: number;
  code: string;
  type: string;
  name: ErrorName;
  message: string;
  data?: any;
  stacktrace?: string;
}

/**
 * Creates a synthetic `INTERNAL_SERVER_ERROR` {@link UserFriendlyError} with
 * the given message.  Used as the fallback in {@link UserFriendlyError.fromAny}.
 *
 * @internal
 */
function UnknownError(message: string) {
  return new UserFriendlyError({
    status: 500,
    code: "INTERNAL_SERVER_ERROR",
    type: "INTERNAL_SERVER_ERROR",
    name: "INTERNAL_SERVER_ERROR",
    message,
  });
}

/**
 * Structured server error data keyed by server error name.
 * The exact generated GraphQL data union lives in `@myoxus/graphql`; keeping it
 * there prevents a foundational error package from depending on its consumer.
 */
export type ErrorData = Record<string, unknown>;

/** Machine-readable GraphQL metadata retained across UI error normalization. */
export type GraphQLErrorExtensions = Record<string, unknown>;

/**
 * A `GraphQLError` subclass whose `extensions` field accepts both the canonical
 * {@link UserFriendlyErrorResponse} envelope and domain-specific metadata.
 *
 * Thrown by the GraphQL fetcher when the server returns an error object inside
 * the `errors` array of a GraphQL response.
 */
export class GraphQLError extends BaseGraphQLError {
  override extensions!: Partial<UserFriendlyErrorResponse> &
    GraphQLErrorExtensions;
}

/**
 * The primary application error class used throughout the Myoxus frontend.
 *
 * Wraps any thrown value — server GraphQL errors, network failures, or plain
 * strings — into a consistent shape with typed `name`, `status`, and `code`
 * fields.
 *
 * Use {@link UserFriendlyError.fromAny} as a catch-all converter instead of
 * constructing instances directly.
 */
export class UserFriendlyError
  extends Error
  implements UserFriendlyErrorResponse
{
  readonly status = this.response.status;
  readonly code = this.response.code;
  readonly type = this.response.type;
  override readonly name = this.response.name;
  override readonly message = this.response.message;
  readonly data = this.response.data;
  readonly stacktrace = this.response.stacktrace;
  /**
   * Original GraphQL metadata such as conflict state or retry information.
   * This is intentionally preserved instead of forcing every server error into
   * the older user-friendly envelope before domain consumers can inspect it.
   */
  readonly extensions = this.graphqlExtensions;

  /**
   * Converts any thrown value into a `UserFriendlyError`.
   *
   * Accepts `UserFriendlyError` (returned as-is), `GraphQLError` (reads
   * `extensions`), objects with `{type, name, message}`, objects with
   * `{message}`, and plain strings.  Anything else becomes an
   * `INTERNAL_SERVER_ERROR` with a generic message.
   */
  static fromAny(anything: any) {
    if (anything instanceof UserFriendlyError) {
      return anything;
    }

    switch (typeof anything) {
      case "string":
        return UnknownError(anything);
      case "object": {
        if (anything) {
          if (anything instanceof GraphQLError) {
            const extensions = anything.extensions ?? {};
            const code =
              typeof extensions.code === "string"
                ? extensions.code
                : "INTERNAL_SERVER_ERROR";
            const type =
              typeof extensions.type === "string" ? extensions.type : code;
            const name =
              typeof extensions.name === "string" ? extensions.name : type;
            return new UserFriendlyError(
              {
                status:
                  typeof extensions.status === "number"
                    ? extensions.status
                    : 500,
                code,
                type,
                name: name as ErrorName,
                message:
                  typeof extensions.message === "string"
                    ? extensions.message
                    : anything.message,
                data: extensions.data,
                stacktrace:
                  typeof extensions.stacktrace === "string"
                    ? extensions.stacktrace
                    : undefined,
              },
              extensions,
            );
          } else if (anything.type && anything.name && anything.message) {
            return new UserFriendlyError(anything);
          } else if (anything.message) {
            return UnknownError(anything.message);
          }
        }
      }
    }

    return UnknownError("Unhandled error raised. Please contact us for help.");
  }

  constructor(
    private readonly response: UserFriendlyErrorResponse,
    private readonly graphqlExtensions?: GraphQLErrorExtensions,
  ) {
    super(response.message);
  }

  /** Returns `true` if this error has the given {@link ErrorName}. */
  is(name: ErrorName) {
    return this.name === name;
  }

  /** Returns `true` if this error has the given HTTP status code. */
  isStatus(status: number) {
    return this.status === status;
  }

  /** Static predicate — useful as a filter callback (e.g. in RxJS `backoffRetry`). */
  static isNetworkError(error: UserFriendlyError) {
    return error.name === "NETWORK_ERROR";
  }

  /** Static predicate — returns `true` for all errors that are NOT network errors. */
  static notNetworkError(error: UserFriendlyError) {
    return !UserFriendlyError.isNetworkError(error);
  }

  /** Instance convenience wrapper for {@link UserFriendlyError.isNetworkError}. */
  isNetworkError() {
    return UserFriendlyError.isNetworkError(this);
  }

  /** True when the consuming Database surface must open conflict resolution. */
  isDatabaseConflict() {
    return isDatabaseConflictErrorName(this.name);
  }

  /** Instance convenience wrapper for {@link UserFriendlyError.notNetworkError}. */
  notNetworkError() {
    return UserFriendlyError.notNetworkError(this);
  }
}
