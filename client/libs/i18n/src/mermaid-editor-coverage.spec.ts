/**
 * INV-MERMAID-I18N-1: Mermaid editor chrome is sourced from the central
 *                      client i18n resources, not from ad-hoc UI literals.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSync } from "@swc/core";

import {
  MERMAID_I18N_KEYS,
  MERMAID_SHARED_I18N_KEYS,
} from "@virgultum/block-mermaid";
import { describe, expect, test } from "vitest";

import de from "./resources/de.json";
import en from "./resources/en.json";

const PREFIX = "com.myoxus.editor.mermaid.";
const enDict = en as Record<string, string>;
const deDict = de as Record<string, string>;
const mermaidKeys = Object.keys(enDict).filter((key) => key.startsWith(PREFIX));
const mermaidBlockKeys = Object.values(MERMAID_I18N_KEYS).map(
  (key) => `${PREFIX}${key}`,
);
const mainLocalizedLocaleCodes = ["de", "fr", "es"] as const;
// Proper names, technical vocabulary and value-only templates can match English.
// Pin both the key and exact reviewed text so a new English fallback still fails.
const intentionalIdenticalTranslations: Record<
  string,
  Record<string, string>
> = {
  de: {
    "git-graph-commit": "Commit",
    "state-region": "Region",
    "state-start": "Start",
    "er-alias": "Alias",
    "architecture-icon": "Icon",
    "architecture-service": "Service",
    "chart-x": "X",
    "chart-y": "Y",
    "diagram-type-c4": "C4",
    "diagram-type-kanban": "Kanban",
    "diagram-type-mindmap": "Mindmap",
    "diagram-type-treemap": "Treemap",
    "page-zoom-percent": "{{percent}}%",
    "option-neutral": "Neutral",
    "quadrant-markdown": "Markdown",
    "quadrant-position": "Position",
    "radar-conversion-impact": "{{axis}}: {{value}}",
    "radar-polygon": "Polygon",
    "gantt-start": "Start",
    "gantt-status": "Status",
    "gantt-marker": "Marker",
    "sankey-label-legacy": "Standard",
    "gantt-binding-link": "Link",
    "gantt-binding-callback": "Callback",
    "gantt-binding-url": "URL",
    "gantt-binding-argument": "Argument {{index}}",
    "kanban-ticket": "Ticket",
    "class-annotation": "Annotation",
    "class-operation": "Operation",
    "class-aggregation": "Aggregation",
    "sequence-fragment": "Fragment",
    "sequence-position": "Position",
    "sequence-arrow-description":
      "{{line}} · {{direction}} · {{marker}} ({{token}})",
    "sequence-fragment-kind-opt": "Optional",
    "sequence-fragment-kind-par": "Parallel",
    "block-node": "Block",
    "selected-c4-link": "Link",
    "selected-c4-sprite": "Sprite",
    "selected-c4-tags": "Tags",
    "c4-add-relation": "Relation",
  },
  fr: {
    "git-graph-commit": "Commit",
    "state-transition": "Transition",
    "er-alias": "Alias",
    "selected-c4-description": "Description",
    "architecture-service": "Service",
    "chart-source": "Source",
    "chart-x": "X",
    "chart-y": "Y",
    "diagram-type-architecture": "Architecture",
    "diagram-type-c4": "C4",
    "diagram-type-gantt": "Gantt",
    "diagram-type-kanban": "Kanban",
    "diagram-type-quadrant": "Quadrant",
    "diagram-type-radar": "Radar",
    "diagram-type-sankey": "Sankey",
    "diagram-type-treemap": "Treemap",
    "mode-source": "Source",
    "page-zoom-percent": "{{percent}}%",
    "option-accent": "Accent",
    "quadrant-markdown": "Markdown",
    "quadrant-position": "Position",
    "radar-configuration": "Configuration",
    "source-value": "Source: {{value}}",
    "radar-conversion-impact": "{{axis}}: {{value}}",
    "shape-rect": "Rectangle",
    "option-association": "Association",
    "option-composition": "Composition",
    "option-participant": "Participant",
    "journey-score": "Score",
    "sankey-label-legacy": "Standard",
    "treemap-classes": "Classes",
    "treemap-section": "Section",
    "treemap-type": "Type",
    "gantt-section": "Section",
    "gantt-binding-callback": "Callback",
    "gantt-binding-url": "URL",
    "gantt-binding-argument": "Argument {{index}}",
    "kanban-ticket": "Ticket",
    "journey-section": "Section",
    "journey-occurrences": "Occurrences",
    "class-annotation": "Annotation",
    "class-direction": "Direction",
    "sequence-participant": "Participant",
    "sequence-message": "Message",
    "sequence-activation": "Activation",
    "sequence-fragment": "Fragment",
    "sequence-note": "Note",
    "sequence-position": "Position",
    "sequence-arrow-description":
      "{{line}} · {{direction}} · {{marker}} ({{token}})",
    "sequence-participant-type-collections": "Collection",
    "sequence-participant-type-participant": "Participant",
    "sequence-fragment-kind-alt": "Alternatives",
    "block-composite": "Composite",
    "selected-c4-sprite": "Sprite",
    "selected-c4-tags": "Tags",
    "c4-add-relation": "Relation",
  },
  es: {
    "git-graph-commit": "Commit",
    "er-alias": "Alias",
    "chart-x": "X",
    "chart-y": "Y",
    "diagram-type-c4": "C4",
    "diagram-type-gantt": "Gantt",
    "diagram-type-kanban": "Kanban",
    "diagram-type-radar": "Radar",
    "page-zoom-percent": "{{percent}}%",
    "option-neutral": "Neutral",
    "option-error": "Error",
    "quadrant-markdown": "Markdown",
    "radar-conversion-impact": "{{axis}}: {{value}}",
    "option-actor": "Actor",
    "gantt-binding-callback": "Callback",
    "gantt-binding-url": "URL",
    "kanban-ticket": "Ticket",
    "packet-field-label": "{{label}}: bits {{start}}–{{end}}, {{width}} bits",
    "sequence-arrow-description":
      "{{line}} · {{direction}} · {{marker}} ({{token}})",
    "sequence-participant-type-actor": "Actor",
    "sequence-participant-type-control": "Control",
    general: "General",
    "selected-c4-sprite": "Sprite",
  },
};

function consumedMermaidKeys(): Set<string> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const keys = new Set(mermaidBlockKeys);
  // Native React chrome consumes the same vocabulary without going through the
  // renderer's message registry. Include its literal keys in both directions.
  for (const path of globSync("client/libs/core/src/**/*.{ts,tsx}", {
    cwd: root,
  })) {
    if (/\.(spec|test)\./.test(path)) continue;
    const source = readFileSync(
      new URL(path, new URL("../../../../", import.meta.url)),
      "utf8",
    );
    for (const match of source.matchAll(
      /["'](com\.myoxus\.editor\.mermaid\.[^"']+)["']/g,
    ))
      keys.add(match[1]);
  }
  const source = readFileSync(
    new URL(
      "../../../../virgultum/editor/blocks/mermaid/src/i18n.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const ast = parseSync(source, { syntax: "typescript" });
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    const declaration = node.declarations.find(
      (item) =>
        item.id.type === "Identifier" &&
        item.id.value === "MERMAID_DIAGRAM_TYPE_I18N_SUFFIX",
    );
    if (!declaration) continue;
    const initializer = declaration.init;
    if (
      initializer?.type !== "TsSatisfiesExpression" ||
      initializer.expression.type !== "TsConstAssertion" ||
      initializer.expression.expression.type !== "ObjectExpression"
    )
      throw new Error("Unsupported Mermaid diagram type registry");
    for (const property of initializer.expression.expression.properties) {
      if (
        property.type !== "KeyValueProperty" ||
        property.value.type !== "StringLiteral"
      )
        throw new Error("Mermaid diagram type suffix must remain a literal");
      keys.add(PREFIX + "diagram-type-" + property.value.value);
    }
  }
  return keys;
}

function loadLocale(code: string): Record<string, string> {
  const file = new URL(`./resources/${code}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

function placeholderTokens(value: string) {
  return Array.from(
    value.matchAll(/\{\{(\w+)\}\}/g),
    (match) => match[1],
  ).sort();
}

describe("INV-MERMAID-I18N-1: central Mermaid editor i18n coverage", () => {
  test("en.json matches all renderer and native editor consumers", () => {
    expect(new Set(mermaidKeys)).toEqual(consumedMermaidKeys());
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-journey-actors",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-task-duration",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-planning-lane-title",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.visual-add-planning-item",
    );
  });

  test.each(["en", ...mainLocalizedLocaleCodes])(
    "%s includes every Mermaid editor key",
    (code) => {
      const dict = loadLocale(code);
      const missing = [
        ...mermaidKeys,
        ...Object.values(MERMAID_SHARED_I18N_KEYS),
      ].filter((key) => !(key in dict));

      expect(
        missing,
        `${code} is missing Mermaid editor keys: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );

  test.each(mainLocalizedLocaleCodes)(
    "%s localizes Mermaid editor strings instead of inheriting English fallbacks",
    (code) => {
      const dict = code === "de" ? deDict : loadLocale(code);
      const intentionallyIdentical =
        intentionalIdenticalTranslations[code] ?? {};
      const inherited = mermaidKeys.filter(
        (key) =>
          dict[key] === enDict[key] &&
          intentionallyIdentical[key.slice(PREFIX.length)] !== enDict[key],
      );

      expect(
        inherited,
        `${code} still inherits English Mermaid editor strings: ${inherited.join(", ")}`,
      ).toEqual([]);
    },
  );

  test.each(mainLocalizedLocaleCodes)(
    "%s preserves Mermaid interpolation placeholders",
    (code) => {
      const dict = code === "de" ? deDict : loadLocale(code);
      const mismatched = mermaidKeys.filter((key) => {
        return (
          placeholderTokens(dict[key]).join(",") !==
          placeholderTokens(enDict[key]).join(",")
        );
      });

      expect(
        mismatched,
        `${code} has Mermaid placeholder drift: ${mismatched.join(", ")}`,
      ).toEqual([]);
    },
  );
});
