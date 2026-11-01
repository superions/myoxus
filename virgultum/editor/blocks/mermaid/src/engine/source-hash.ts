// SPDX-License-Identifier: AGPL-3.0-or-later

/** Stable Source fingerprint shared by pure engines and their consuming hosts. */
export function hashMermaidSource(source: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
