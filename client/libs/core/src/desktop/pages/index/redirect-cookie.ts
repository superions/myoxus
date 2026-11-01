// SPDX-License-Identifier: AGPL-3.0-or-later

const WORKSPACE_REDIRECT_COOKIE = "myoxus_redirect";

function safeDecodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clearCookie(name: string, doc: Document) {
  doc.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function readCookie(name: string, doc: Document) {
  const prefix = `${name}=`;
  const cookies = doc.cookie ? doc.cookie.split("; ") : [];
  const match = cookies.find((cookie) => cookie.startsWith(prefix));
  if (!match) {
    return null;
  }
  return safeDecodeCookieValue(match.slice(prefix.length));
}

export function sanitizeWorkspaceRedirectPath(
  value: string | null | undefined,
  origin = globalThis.location?.origin ?? "http://localhost",
) {
  if (!value || value.length > 2048) {
    return null;
  }
  const hasControlCharacter = Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.includes("\\") ||
    hasControlCharacter
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) {
    return null;
  }

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return normalized.startsWith("/workspace/") ? normalized : null;
}

export function consumeWorkspaceRedirectCookie(
  doc: Document = document,
  origin = globalThis.location?.origin ?? "http://localhost",
) {
  const raw = readCookie(WORKSPACE_REDIRECT_COOKIE, doc);
  if (raw === null) {
    return null;
  }
  clearCookie(WORKSPACE_REDIRECT_COOKIE, doc);
  return sanitizeWorkspaceRedirectPath(raw, origin);
}
