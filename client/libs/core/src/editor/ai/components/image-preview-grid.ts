// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

interface PreviewEntry {
  url: string;
  revoked: boolean;
}

/**
 * Manages object URL lifetimes for pending File previews without taking
 * ownership of the File array itself. Failed previews stay marked revoked
 * until the File is removed so rerenders do not repeatedly re-create them.
 */
export class ImagePreviewUrls {
  private readonly entries = new Map<File, PreviewEntry>();

  readonly release = (file: File, expectedUrl?: string) => {
    const entry = this.entries.get(file);
    if (!entry || entry.revoked) return;
    if (expectedUrl && entry.url !== expectedUrl) return;
    URL.revokeObjectURL(entry.url);
    entry.revoked = true;
  };

  sync(files: readonly File[]): Array<{ file: File; url: string }> {
    const active = new Set(files);
    for (const file of this.entries.keys()) {
      if (!active.has(file)) {
        this.release(file);
        this.entries.delete(file);
      }
    }

    return files.map((file) => {
      let entry = this.entries.get(file);
      if (!entry) {
        entry = { url: URL.createObjectURL(file), revoked: false };
        this.entries.set(file, entry);
      }
      return { file, url: entry.url };
    });
  }

  dispose() {
    for (const file of this.entries.keys()) {
      this.release(file);
    }
    this.entries.clear();
  }
}
