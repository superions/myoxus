// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  readMermaidArchitectureConfig,
  resetMermaidArchitectureConfigDirectives,
  validateMermaidArchitectureConfig,
  writeMermaidArchitectureConfigDirective,
} from "../config.js";
import type {
  MermaidArchitectureConfig,
  MermaidArchitectureModel,
} from "../model.js";
import {
  architectureCommandResult,
  cloneArchitectureModel,
  unchangedArchitectureCommand,
} from "./shared.js";

function architectureSourceWithDirectives(
  model: MermaidArchitectureModel,
  directives: readonly string[],
) {
  const document = model.sourceDocument;
  if (!document) return null;
  let source = document.lines.join("\n");
  const replacements = new Map<string, string | undefined>();
  const changed = directives.find(
    (directive) => !model.directives.includes(directive),
  );
  let changedConsumed = false;
  for (const previous of model.directives) {
    if (directives.includes(previous)) {
      replacements.set(previous, previous);
      continue;
    }
    const replacement = changedConsumed ? undefined : changed;
    source = source.replace(previous, replacement ?? "");
    replacements.set(previous, replacement);
    changedConsumed = true;
  }
  const additions = directives.filter(
    (directive) =>
      !model.directives.includes(directive) && directive !== changed,
  );
  if (changed && !changedConsumed) additions.unshift(changed);
  if (additions.length) {
    const lines = source.split("\n");
    let insertion = 0;
    if (lines[0]?.trim() === "---") {
      const end = lines.findIndex(
        (line, index) => index > 0 && line.trim() === "---",
      );
      insertion = end >= 0 ? end + 1 : 0;
    }
    lines.splice(insertion, 0, ...additions);
    source = lines.join("\n");
  }
  return { lines: source.split("\n"), replacements };
}

export function updateMermaidArchitectureDiagram(
  model: MermaidArchitectureModel,
  patch: {
    accessibilityDescription?: string;
    accessibilityTitle?: string;
    config?: MermaidArchitectureConfig;
  },
) {
  const selection = { kind: "diagram" } as const;
  if (
    patch.config !== undefined &&
    !validateMermaidArchitectureConfig(patch.config)
  ) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.config-invalid",
    );
  }
  const next = cloneArchitectureModel(model);
  if (patch.accessibilityDescription !== undefined) {
    next.accessibilityDescription = patch.accessibilityDescription.trim();
  }
  if (patch.accessibilityTitle !== undefined) {
    next.accessibilityTitle = patch.accessibilityTitle.trim();
  }
  if (patch.config !== undefined) {
    const hasOverrides = Object.values(patch.config).some(
      (value) => value !== undefined,
    );
    const directives = hasOverrides
      ? writeMermaidArchitectureConfigDirective(model.directives, patch.config)
      : resetMermaidArchitectureConfigDirectives(model.directives);
    const sourceUpdate = architectureSourceWithDirectives(model, directives);
    if (!sourceUpdate || !next.sourceDocument) {
      return unchangedArchitectureCommand(
        model,
        selection,
        "canvas",
        "architecture.config-invalid",
      );
    }
    const previousLines = next.sourceDocument.lines;
    const lines = sourceUpdate.lines;
    const firstChanged = previousLines.findIndex(
      (line, index) => line !== lines[index],
    );
    const delta = lines.length - previousLines.length;
    next.directives = [...directives];
    next.sourceDocument.lines = lines;
    if (delta && firstChanged >= 0) {
      for (const record of next.sourceDocument.records) {
        if (record.startLine >= firstChanged) record.startLine += delta;
        if (record.endLine > firstChanged) record.endLine += delta;
      }
    }
    for (const record of next.sourceDocument.records) {
      if (!record.inlineDirectives) continue;
      const inlineDirectives = record.inlineDirectives.flatMap((directive) => {
        const replacement = sourceUpdate.replacements.get(directive);
        return replacement ? [replacement] : [];
      });
      record.inlineDirectives = inlineDirectives.length
        ? inlineDirectives
        : undefined;
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(next, true, selection, "canvas")
    : unchangedArchitectureCommand(
        model,
        selection,
        "canvas",
        "architecture.no-change",
      );
}

export function mermaidArchitectureDiagramConfig(
  model: MermaidArchitectureModel,
) {
  return readMermaidArchitectureConfig(model.directives);
}
