import { shell } from "electron";

const DEFAULT_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export interface OpenExternalOptions {
  additionalProtocols?: string[];
}

export const isAllowedExternalUrl = (
  rawUrl: string,
  additionalProtocols: Iterable<string> = [],
) => {
  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.toLowerCase();
    if (DEFAULT_ALLOWED_PROTOCOLS.has(protocol)) {
      return true;
    }

    for (const extra of additionalProtocols) {
      if (protocol === extra.toLowerCase()) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
};

export const openExternalSafely = async (
  rawUrl: string,
  options: OpenExternalOptions = {},
) => {
  const { additionalProtocols = [] } = options;

  if (!isAllowedExternalUrl(rawUrl, additionalProtocols)) {
    throw new TypeError("External URL is not allowed");
  }

  try {
    await shell.openExternal(rawUrl);
  } catch {
    // IPC callers must see failure, without retaining credential-bearing URLs
    // or platform errors in logs or user-visible diagnostics.
    throw new Error("The system could not open the external URL");
  }
};
export const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(
  DEFAULT_ALLOWED_PROTOCOLS,
);
