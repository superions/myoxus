abstract class BaseAIError extends Error {
  abstract readonly type: AIErrorType;
}

export enum AIErrorType {
  GeneralNetworkError = "GeneralNetworkError",
  PaymentRequired = "PaymentRequired",
  Unauthorized = "Unauthorized",
  RequestTimeout = "RequestTimeout",
}

export class UnauthorizedError extends BaseAIError {
  readonly type = AIErrorType.Unauthorized;

  constructor() {
    super("Unauthorized");
  }
}

// HTTP 402 — mapped as a generic server-side error (no billing in Myoxus)
export class PaymentRequiredError extends BaseAIError {
  readonly type = AIErrorType.PaymentRequired;

  constructor() {
    super("Service temporarily unavailable");
  }
}

// general 500x error
export class GeneralNetworkError extends BaseAIError {
  readonly type = AIErrorType.GeneralNetworkError;

  constructor(
    message: string = "Network error",
    readonly code?: string,
  ) {
    super(message);
  }
}

// request timeout
export class RequestTimeoutError extends BaseAIError {
  readonly type = AIErrorType.RequestTimeout;

  constructor(message: string = "Request timeout") {
    super(message);
  }
}

export type AIError =
  | UnauthorizedError
  | PaymentRequiredError
  | GeneralNetworkError
  | RequestTimeoutError;
