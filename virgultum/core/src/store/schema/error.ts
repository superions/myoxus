import { ErrorCode, VirgultumError } from "../../primitives/exceptions/index";

export class SchemaValidateError extends VirgultumError {
  constructor(flavour: string, message: string) {
    super(
      ErrorCode.SchemaValidateError,
      `Invalid schema for ${flavour}: ${message}`,
    );
  }
}
