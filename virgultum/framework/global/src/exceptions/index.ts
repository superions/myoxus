import { ErrorCode } from "./code.js";

export class VirgultumError extends Error {
  static ErrorCode = ErrorCode;

  code: ErrorCode;

  isFatal: boolean;

  constructor(code: ErrorCode, message: string, options?: { cause: Error }) {
    super(message, options);
    this.name = "VirgultumError";
    this.code = code;
    this.isFatal = code >= 10000;
  }
}

export function handleError(error: Error) {
  if (!(error instanceof VirgultumError)) {
    throw error;
  }

  if (error.isFatal) {
    throw new Error(
      "A fatal error for Virgultum occurs, please contact the team if you find this.",
      { cause: error },
    );
  }

  console.error(
    "A runtime error for Virgultum occurs, you can ignore this error if it won't break the user experience.",
  );
  console.error(error.stack);
}

export * from "./code.js";
