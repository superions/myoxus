// SPDX-License-Identifier: AGPL-3.0-or-later

export function isValidGitSyncRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^git@[^:/\s]+:[^\s]+$/.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return (
      ["http:", "https:", "ssh:"].includes(parsed.protocol) &&
      parsed.hostname.length > 0 &&
      parsed.pathname !== "/"
    );
  } catch {
    return false;
  }
}

export function isValidGitSyncBranch(branch: string): boolean {
  if (!branch) return true;
  return /^[a-zA-Z0-9_\-/.]+$/.test(branch) && !branch.startsWith("-");
}
