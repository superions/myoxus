export function readTemplateErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) {
      return message;
    }
  }

  if (typeof error === "string") {
    const message = error.trim();
    if (message) {
      return message;
    }
  }

  return "Unexpected error";
}

export function withTemplateErrorContext(
  context: string,
  error: unknown,
): string {
  return `${context}: ${readTemplateErrorMessage(error)}`;
}
