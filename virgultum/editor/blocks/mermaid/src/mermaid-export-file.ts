// SPDX-License-Identifier: AGPL-3.0-or-later

export function normalizeMermaidExportFileName(title: string) {
  return (
    (title || "Untitled").replace(/[\\/:*?"<>|]/g, "_").trim() || "Untitled"
  );
}
