/**
 * INV-VIRGULTUM-I18N-3: migrated editor chrome cannot grow an unowned visible
 * literal. This guard intentionally scans only the package surfaces migrated
 * by P-VIRG-I18N-HARDCODED; Mermaid, BPMN and editor-local Data-View remain
 * outside the phase and are never included here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const migratedFiles = [
  "virgultum/editor/all/src/blocks/root/configs/toolbar.ts",
  "virgultum/embeds/src/note/configs/toolbar.ts",
  "virgultum/content/src/blocks/callout/configs/toolbar.ts",
  "virgultum/editor/all/src/widgets/keyboard-toolbar/config.ts",
  "virgultum/embeds/src/attachment/configs/toolbar.ts",
  "virgultum/content/src/blocks/code/code-toolbar/controller.ts",
  "virgultum/embeds/src/embed-doc/embed-linked-doc-block/configs/toolbar.ts",
  "virgultum/embeds/src/embed-doc/embed-synced-doc-block/configs/toolbar.ts",
  "virgultum/editor/all/src/fragments/outline/outline-viewer.ts",
  "client/libs/core/src/editor/view-extensions/editor-view/editor-chrome/reference-editor.tsx",
  "virgultum/canvas/src/blocks/frame/present/present-button.ts",
] as const;

const sourcePropertyPattern =
  /\b(label|tooltip|name|description|placeholder|aria-label)\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
const textCallPattern =
  /\b(?:text|resolveLegacyEditorText)\(\s*["'`]([^"'`]+)["'`]/g;

const legacyEditorTextSource = readFileSync(
  join(repoRoot, "virgultum/core/src/services/legacy-editor-text.ts"),
  "utf8",
);
const legacyEditorTextKeys = new Set(
  Array.from(
    legacyEditorTextSource.matchAll(
      /^\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*)):\s*"/gm,
    ),
    (match) => match[1] ?? match[2],
  ),
);

type LiteralFinding = {
  file: string;
  literal: string;
  role: "property" | "text-call";
};

function extractVisibleLiterals(
  source: string,
  file: string,
): LiteralFinding[] {
  const findings: LiteralFinding[] = [];

  for (const match of source.matchAll(sourcePropertyPattern)) {
    // Only name is the old command identity in this specific owner. Raw
    // labels/tooltips in the same file must still be rejected.
    if (
      match[1] === "name" &&
      file.endsWith("widgets/keyboard-toolbar/config.ts")
    )
      continue;
    findings.push({ file, literal: match[2], role: "property" });
  }
  for (const match of source.matchAll(textCallPattern)) {
    findings.push({ file, literal: match[1], role: "text-call" });
  }

  return findings;
}

function isOwnedVisibleLiteral(finding: LiteralFinding) {
  const { literal, role } = finding;
  if (literal.length === 0 || literal.startsWith("${")) return true;
  // A known resource is safe only when reached through the explicit resolver.
  return role === "text-call" && legacyEditorTextKeys.has(literal);
}

export function auditVisibleLiterals(
  source: string,
  file = "<fixture>",
): LiteralFinding[] {
  return extractVisibleLiterals(source, file).filter(
    (finding) => !isOwnedVisibleLiteral(finding),
  );
}

// Every recorded residual display site in this bounded scope is migrated.
const legacyDisplayDebt: Record<string, number> = {};

describe("INV-VIRGULTUM-I18N-3: migrated editor chrome owns visible copy", () => {
  test("migrated surfaces do not add to the explicitly recorded legacy display debt", () => {
    const counts: Record<string, number> = {};
    for (const file of migratedFiles) {
      for (const { literal } of auditVisibleLiterals(
        readFileSync(join(repoRoot, file), "utf8"),
        file,
      )) {
        const key = `${file} :: ${literal}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    // Keep this bounded surface free of raw display copy.
    // Added copy (including a known label) requires a typed descriptor.
    expect(counts).toEqual(legacyDisplayDebt);
  });

  test("a known translated word is still rejected as a raw property", () => {
    expect(auditVisibleLiterals('label: "Copy"')[0]?.literal).toBe("Copy");
    expect(auditVisibleLiterals('tooltip: "Delete"')[0]?.literal).toBe(
      "Delete",
    );
    expect(auditVisibleLiterals('text("Copy")')).toEqual([]);
    expect(
      auditVisibleLiterals(
        'label: "Copy"',
        "virgultum/editor/all/src/widgets/keyboard-toolbar/config.ts",
      ),
    ).toHaveLength(1);
  });

  test("a newly introduced raw visible literal fails the guard", () => {
    expect(auditVisibleLiterals('label: "New untranslated control"')).toEqual([
      {
        file: "<fixture>",
        literal: "New untranslated control",
        role: "property",
      },
    ]);
  });
});
