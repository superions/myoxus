/**
 * Synchronous pure helper — no React, no framework imports.
 *
 * Returns the effective download URL: prefers `serverConfig.client.downloadUrl`
 * when provided and non-empty, otherwise falls back to `BUILD_CONFIG.downloadUrl`.
 */
export function getDownloadUrl(
  serverConfig?: { client?: { downloadUrl?: string } } | null,
): string {
  const url = serverConfig?.client?.downloadUrl;
  return url && url.length > 0 ? url : BUILD_CONFIG.downloadUrl;
}
