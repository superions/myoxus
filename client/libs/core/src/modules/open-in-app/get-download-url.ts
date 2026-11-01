export { getDownloadUrl } from "./get-download-url-pure";

/**
 * React hook: returns the effective download URL.
 * Uses BUILD_CONFIG.downloadUrl — safe in all component contexts.
 */
export function useDownloadUrl(): string {
  return BUILD_CONFIG.downloadUrl;
}
