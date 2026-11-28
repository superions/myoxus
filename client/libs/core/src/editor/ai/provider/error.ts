// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export enum AIErrorType {
  GeneralNetworkError = "GeneralNetworkError",
  Unauthorized = "Unauthorized",
  RequestTimeout = "RequestTimeout",
}

abstract class AIErrorBase extends Error {
  abstract readonly type: AIErrorType;
}

export class UnauthorizedError extends AIErrorBase {
  readonly type = AIErrorType.Unauthorized;

  constructor() {
    super("Unauthorized");
  }
}

export class GeneralNetworkError extends AIErrorBase {
  readonly type = AIErrorType.GeneralNetworkError;

  constructor(
    message = "Network error",
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RequestTimeoutError extends AIErrorBase {
  readonly type = AIErrorType.RequestTimeout;

  constructor(message = "Request timeout") {
    super(message);
  }
}

export type AIError =
  UnauthorizedError | GeneralNetworkError | RequestTimeoutError;
