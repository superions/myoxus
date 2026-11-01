// SPDX-License-Identifier: AGPL-3.0-or-later

import { UserFriendlyError } from "@myoxus/error";

export function isDocumentNotFoundError(error: unknown): boolean {
  const normalized = UserFriendlyError.fromAny(error);
  if (
    [normalized.name, normalized.code, normalized.type].includes(
      "DOC_NOT_FOUND",
    )
  ) {
    return true;
  }

  let rawDescription = "";
  try {
    rawDescription = String(error ?? "");
  } catch {
    // An unprintable foreign error is not sufficient evidence for termination.
  }
  const message = `${normalized.message} ${rawDescription}`.toLowerCase();
  return (
    message.includes("document not found") ||
    message.includes("not found: document")
  );
}
