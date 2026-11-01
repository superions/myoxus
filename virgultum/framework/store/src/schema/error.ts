import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";

export class SchemaValidateError extends VirgultumError {
  constructor(flavour: string, message: string) {
    super(
      ErrorCode.SchemaValidateError,
      `Invalid schema for ${flavour}: ${message}`,
    );
  }
}
