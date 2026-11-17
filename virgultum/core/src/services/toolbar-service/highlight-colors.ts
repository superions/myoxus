// SPDX-License-Identifier: AGPL-3.0-or-later
import { editorMessage } from "../i18n-service";

export const editorTextColorLabels = {
  red: editorMessage("com.myoxus.editor.table.color.red", "Red"),
  orange: editorMessage("com.myoxus.editor.table.color.orange", "Orange"),
  yellow: editorMessage("com.myoxus.editor.table.color.yellow", "Yellow"),
  green: editorMessage("com.myoxus.editor.table.color.green", "Green"),
  teal: editorMessage("com.myoxus.editor.table.color.teal", "Teal"),
  blue: editorMessage("com.myoxus.editor.table.color.blue", "Blue"),
  purple: editorMessage("com.myoxus.editor.table.color.purple", "Purple"),
  grey: editorMessage("com.myoxus.editor.table.color.grey", "Grey"),
};
export const editorMarkerColorLabels = {
  yellow: editorMessage("com.myoxus.editor.text-marker.yellow", "Neon yellow"),
  green: editorMessage("com.myoxus.editor.text-marker.green", "Neon green"),
  pink: editorMessage("com.myoxus.editor.text-marker.pink", "Neon pink"),
  orange: editorMessage("com.myoxus.editor.text-marker.orange", "Neon orange"),
  blue: editorMessage("com.myoxus.editor.text-marker.blue", "Neon blue"),
};

/** Semantic background choices shared by editor controls and authored callouts. */
export const editorBackgroundColors = [
  ...Object.entries(editorTextColorLabels).map(([name, label]) => ({
    name,
    label,
    background:
      name === "grey"
        ? "var(--myoxus-tag-gray)"
        : `var(--myoxus-text-highlight-${name})`,
    emphasis: `var(--myoxus-text-highlight-foreground-${name})`,
    ink: undefined as string | undefined,
  })),
  ...Object.entries(editorMarkerColorLabels).map(([name, label]) => ({
    name: `neon-${name}`,
    label,
    background: `var(--myoxus-sem-text-marker-${name})`,
    emphasis: `var(--myoxus-sem-text-marker-${name})`,
    ink: "var(--myoxus-sem-text-marker-ink)",
  })),
];
