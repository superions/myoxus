// SPDX-License-Identifier: AGPL-3.0-or-later

export function readZip(
  bytes: Uint8Array,
  limits?: { maxEntries?: number; maxEntryBytes?: number; maxBytes?: number },
): Promise<Map<string, { data: Buffer; directory: boolean }>>;

export function writeZip(
  entries: Iterable<
    readonly [
      string,
      string | Uint8Array | { data?: string | Uint8Array; directory?: boolean },
    ]
  >,
  options?: { date?: Date; level?: number },
): Promise<Buffer>;
